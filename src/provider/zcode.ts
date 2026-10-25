/**
 * ZCode provider adapter: one DSH route backed by the locally installed ZCode CLI.
 *
 * The CLI is the model. This adapter never speaks the upstream HTTP protocol —
 * it starts one `zcode.cjs` process per model call, hands it the whole turn as a
 * single `-p` prompt, and projects the stdout frames back onto DSH's
 * `StreamChunk` vocabulary. Everything provider-specific therefore lives in the
 * process layer (`../zcode/process.ts`) and the frame recognizer
 * (`../zcode/parser.ts`); this file owns the three things that cannot live
 * there: the message projection, the session binding, and the terminal frame
 * order.
 *
 * ## Why the prompt is one string
 *
 * ZCode 0.17.0 documents exactly one input channel for a one-shot turn: `-p
 * <prompt>`. There is no stdin protocol, no `--input-format json`, no `--model`.
 * So `sessionMode: 'full'` renders the entire DSH history into that one string,
 * each turn. Two consequences are real and are handled explicitly rather than
 * papered over:
 *
 * - **Windows caps one command line at 32767 characters.** A long history
 *   therefore cannot be sent through argv. Rather than truncate (which would
 *   silently drop the middle of a conversation and produce an answer about the
 *   wrong context), this adapter fails closed above
 *   {@link PROMPT_ARGV_MAX_CHARS} with an explicit diagnostic.
 * - **Nothing survives the process.** Every call is a fresh session unless
 *   `sessionMode: 'resume'` reuses a `sess_…` id, so the "conversation" the CLI
 *   sees is exactly the text this adapter builds.
 *
 * ## Frame order (hard contract)
 *
 * `block-start(text)? → text-delta* → block-end(text)? → usage? → finish`.
 *
 * `finish` is always the last chunk, on every path including failures, and a
 * started block is always closed before it. The adapter therefore never throws
 * out of `stream()`: a thrown error would leave the runtime to synthesize a
 * terminal frame, and a synthesized frame loses the provider facts (code,
 * providerCode, request-id) this file already holds in hand.
 *
 * ## Tool policy and unsupported request fields (fail-closed)
 *
 * `toolPolicy` decides what happens to the DSH-owned part of a request; it never
 * decides whether a tool *request* is honored, because a headless `--mode
 * guarded` process has no approval channel and cannot honor one:
 *
 * | policy | request carries `tools` | `temperature`/`maxTokens`/`stop` | image/file block | a tool-shaped stdout frame |
 * | --- | --- | --- | --- | --- |
 * | `reject` | refused before spawn: `UNSUPPORTED_TOOLS` | refused before spawn: `UNSUPPORTED_OPTION` | refused before spawn: `UNSUPPORTED_CONTENT` | child killed; `PERMISSION_REQUIRED` or `UNSUPPORTED_TOOLS` |
 * | `zcode-owned` | schemas dropped, turn proceeds | refused before spawn: `UNSUPPORTED_OPTION` | projected to placeholder text | child killed; `PERMISSION_REQUIRED` or `UNSUPPORTED_TOOLS` |
 * | `dsh-owned` | refused before spawn: `UNSUPPORTED_TOOLS` | refused before spawn: `UNSUPPORTED_OPTION` | projected to placeholder text | unreachable |
 *
 * `dsh-owned` is refused up front because this route has no way to hand a tool
 * call back to DSH: the CLI prints tool progress as terminal text and exits, so
 * projecting a call would either drop it or run the tool twice.
 *
 * `temperature`, `maxTokens` and `stop` have no place in ZCode 0.17.0's
 * one-shot argv form, so accepting them and dropping them silently would let a
 * caller believe a sampling setting took effect. They are refused under every
 * policy, before the process starts.
 *
 * ## Session binding
 *
 * `SessionRegistry` holds a per-conversation serial lock. A turn on conversation
 * A never waits for conversation B, but two turns on A are strictly serial, so a
 * `--resume sess_…` id can never be used twice at once. The session id itself is
 * remembered from stdout (`sess_…`) and persisted through `FileSessionStore`;
 * when the CLI prints no id, nothing is remembered and `resume` simply stays
 * unavailable — this adapter never invents an id.
 *
 * Auxiliary calls (`purpose: 'compaction' | 'session-title'`) bypass both the
 * lock and the session map: they are not the conversation, they must not
 * consume its `--resume` id, and they must not queue behind a long turn.
 *
 * ## Registered deviations from `design.md`
 *
 * - **D-a** The error table maps "tool call in `reject` mode" to
 *   `UNSUPPORTED_TOOLS` and "approval needed" to `PERMISSION_REQUIRED`, while
 *   the B5 checklist names `PERMISSION_REQUIRED` for both. The table wins
 *   because the two events need different fixes; both remain fail-closed.
 * - **D-b** A failed `--resume` attempt does not silently retry in full mode.
 *   Each attempt spends a real quota unit, and `resume` is unverified (see
 *   `tasks.md` recovery condition 2). The stale record is dropped instead, so
 *   the next turn starts clean.
 * - **D-c** Image and file blocks are projected to placeholder text rather than
 *   rejected, except under `toolPolicy: 'reject'`: that policy promises to refuse
 *   anything this route cannot carry, so a reject-mode request carrying an image
 *   or file block fails with `UNSUPPORTED_CONTENT` before the process starts. A
 *   text-only route is exactly what `imageInput: 'off'` means for the permissive
 *   policies, and DSH itself renders offloaded images the same way.
 *
 * ## Unresolved
 *
 * - `toolPolicy` cannot switch off the ZCode CLI's own tool surface: `--mode
 *   guarded` is delegated to the CLI, whose headless behavior is unverified (the
 *   subscription quota expired before a live run). This adapter refuses the DSH
 *   tool schema; it does not and cannot prove that the CLI ran no tool of its own.
 * - The turn is one `-p` argv entry, so the full prompt is visible in the child's
 *   command line to any local process able to read it (inherent to `-p`).
 */

import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ToolCallId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

import {
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  DEFAULT_NODE_PATH,
  DEFAULT_ZCODE_CJS_PATH,
  ZCODE_RETRYABLE_CODES,
  configuredModels,
  filterVisibleModels,
  type Config,
  type ModelConfig,
  type ZcodeToolPolicy,
} from './config.js'
import { ZcodeError, boundDiagnostic, isZcodeError, isZcodeErrorCode } from './error-codes.js'
import { QUOTA_PROVIDER_CODE, recordQuotaObservation } from '../diagnostics.js'
import { FileSessionStore, sessionStorePath } from '../session/file-store.js'
import { SessionRegistry } from '../session/store.js'
import { runZcode, type ZcodeProcessConfig } from '../zcode/process.js'
import { ZcodeStreamParser, parseStdout, type ZcodeFrame, type ZcodeTokenUsage } from '../zcode/parser.js'
import { buildZcodeAccountConfig, type ZcodeAccountConfig } from '../zcode/account-config.js'
import { runZcodeAppServerTurn, type ZcodeAppServerDeps } from '../zcode/app-server.js'
import { readZcodePlanToken } from '../zcode/credential.js'
import { ZCODE_EFFORT_IDS } from '../selection.js'

/** Display name of the provider card; the route id is `providerInfo().id`. */
export const ZCODE_PROVIDER_DISPLAY_NAME = 'ZCode'

/**
 * Diagnostic path handed to `resolveRetryPolicy()`.
 *
 * It names the configuration section that owns the value, so an invalid policy
 * is reported against something the user can actually edit.
 */
export const ZCODE_CONFIG_PATH = 'dsh-zcode-provider'

/**
 * Ceiling on the rendered prompt, in characters.
 *
 * Windows caps a whole command line at 32767 characters, and the prompt is one
 * argv entry. The budget leaves room for the node path, the entry script, the
 * fixed flags and a resumed session id. Exceeding it fails the call instead of
 * truncating the history: a truncated prompt silently answers a different
 * question than the one asked.
 */
export const PROMPT_ARGV_MAX_CHARS = 30_000

/** Prompt length above which the adapter records a diagnostic. */
export const PROMPT_ARGV_WARN_CHARS = 24_000

/**
 * How much stdout one turn keeps for the whole-segment recovery pass.
 *
 * The live path is line-incremental, so this buffer exists only for the case
 * where the CLI printed one pretty-printed JSON document: no single line of it
 * parses, and the answer would otherwise be reported as `ZCODE_PARSE`. The cap
 * is 64 KiB — far beyond any answer this route can carry through argv, and
 * small enough that a runaway child cannot grow it without bound.
 */
const STDOUT_RECOVERY_MAX_CHARS = 64 * 1024

/**
 * Last-resort parse of the whole capture.
 *
 * Returns `undefined` on any parse failure: the caller's fail-closed branch is
 * the authority, and this pass may not turn a broken capture into a success.
 */
function recoverWholeSegment(capture: string): string | undefined {
  try {
    const parsed = parseStdout(capture)
    return parsed.text.length > 0 ? parsed.text : undefined
  } catch {
    return undefined
  }
}

/** This route carries text only; images and files are projected to text. */
const TEXT_ONLY: readonly ModelModality[] = ['text']

/**
 * Fallbacks that mirror the defaults in `./config.ts`.
 *
 * The config schema already applies them, but an adapter can also be
 * constructed directly (tests, tools), and a missing timeout must never mean
 * "no timeout".
 */
const PROCESS_DEFAULTS = {
  timeoutMs: 900_000,
  idleTimeoutMs: 300_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxEventLineLength: 1_048_576,
  maxConcurrent: 4,
  maxQueue: 32,
  queueTimeoutMs: 30_000,
  stdinMode: 'hold' as const,
} as const

/** A stdout frame that asks for a tool or for an approval. */
type ZcodeToolFrame = Extract<ZcodeFrame, { kind: 'tool' }>

/** Why the child process was killed before it exited on its own. */
type AbortCause = 'caller' | 'tool' | 'in-band-error'

/** Diagnostic sink handed in by the bundle entry (`src/index.ts`). */

/**
 * The live selection the settings card writes, as the bundle entry hands it in.
 *
 * Deliberately a structural type instead of `ZcodeSelectionState` from
 * `src/selection.ts`: importing that module would drag the selection store's
 * filesystem dependencies into the adapter's module graph, and the adapter
 * tests must be able to run with no filesystem at all.
 */
export interface ZcodeSelectionLike {
  /** Label only under the CLI transport — both plans spawn the same command. */
  readonly plan?: string | undefined
  /** The model the card picked; the CLI honours it, `plan` and `effort` do not. */
  readonly model?: string | undefined
  /** No CLI flag exists for it, so it never changes a spawned command. */
  readonly effort?: string | undefined
}

export interface ZcodeAdapterDeps {
  /** One structured record per event; the entry serializes it to a log line. */
  readonly logger: (record: unknown) => void
  /**
   * Resolve the working directory of the session's workspace.
   *
   * The host owns this knowledge: `GenerateOptions` carries no workspace, so the
   * bundle entry closes over `sessions` and `workspaceRegistry` and hands the
   * resolved root in. Returning `undefined` is a hard failure, never a fallback
   * to `process.cwd()` (which is the DSH install directory, not the user's
   * project).
   */
  readonly resolveWorkspaceRoot?: ((conversationId: string | undefined) => Promise<string | undefined>) | undefined
  /**
   * Read the settings card's live choice, once per turn.
   *
   * Called at the top of `stream`, before the model guard: a card pick is how
   * this route switches between the models in its catalog, since the CLI has no
   * `--model` flag of its own. Returning `undefined` means "the card has not
   * written a selection", and every field falls back to the configured value.
   */
  readonly getSelection?: (() => ZcodeSelectionLike | undefined) | undefined
}

/**
 * The DSH adapter for ZCode.
 *
 * One instance owns one provider route. The session registry and the retry
 * policy are captured at construction time, like the retry-policy contract
 * requires ("immutable provider policy captured when its adapter route is
 * registered"), so a settings change can only take effect through a new
 * adapter — never by swapping a policy under an in-flight turn.
 */

export class ZcodeAdapter extends LlmAdapter {
  private readonly config: Config
  private readonly logger: (record: unknown) => void
  private readonly provider: string
  private readonly model: string
  private readonly catalog: readonly ModelConfig[]
  private readonly toolPolicy: ZcodeToolPolicy
  private readonly processConfig: ZcodeProcessConfig
  private readonly sessions: SessionRegistry
  private readonly retryPolicy: ResolvedRetryPolicy
  private readonly resolveWorkspaceRoot: ZcodeAdapterDeps['resolveWorkspaceRoot']
  private readonly getSelection: ZcodeAdapterDeps['getSelection']

  constructor(config: Config, deps: ZcodeAdapterDeps) {
    super()
    this.config = config
    this.logger = deps.logger
    this.resolveWorkspaceRoot = deps.resolveWorkspaceRoot
    this.getSelection = deps.getSelection
    this.provider = nonEmpty(config.provider) ?? 'zcode'
    this.model = nonEmpty(config.model) ?? DEFAULT_MODEL
    // One catalog builder for both the adapter and the test/tool surface: the
    // configured `model` is merged in even when `models` omits it, so a profile
    // that sets only `model` never fails `resolveModel` with MODEL_NOT_FOUND.
    this.catalog = configuredModels({ model: config.model, models: config.models ?? DEFAULT_MODELS })
    this.toolPolicy = config.toolPolicy ?? 'dsh-owned'
    this.processConfig = {
      nodePath: nonEmpty(config.nodePath) ?? DEFAULT_NODE_PATH,
      zcodeCjsPath: nonEmpty(config.zcodeCjsPath) ?? DEFAULT_ZCODE_CJS_PATH,
      timeoutMs: config.timeoutMs ?? PROCESS_DEFAULTS.timeoutMs,
      idleTimeoutMs: config.idleTimeoutMs ?? PROCESS_DEFAULTS.idleTimeoutMs,
      stdinMode: config.stdinMode ?? PROCESS_DEFAULTS.stdinMode,
      maxOutputBytes: config.maxOutputBytes ?? PROCESS_DEFAULTS.maxOutputBytes,
      maxEventLineLength: config.maxEventLineLength ?? PROCESS_DEFAULTS.maxEventLineLength,
      maxConcurrent: config.maxConcurrent ?? PROCESS_DEFAULTS.maxConcurrent,
      maxQueue: config.maxQueue ?? PROCESS_DEFAULTS.maxQueue,
      queueTimeoutMs: config.queueTimeoutMs ?? PROCESS_DEFAULTS.queueTimeoutMs,
    }
    const store = new FileSessionStore(sessionStorePath(config.sessionStorePath, process.env))
    this.sessions = new SessionRegistry(store)
    this.retryPolicy = resolveRetryPolicy({
      mode: 'normal',
      maxRetries: config.retryPolicy?.maxRetries ?? 2,
      retryableCodes: this.retryableCodes(),
      backoff: { initialDelayMs: config.retryPolicy?.backoffMs ?? 1_000 },
    }, ZCODE_CONFIG_PATH)
  }

  /** The retry policy captured with this route. */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ZCODE_PROVIDER_DISPLAY_NAME }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  /**
   * Advertise the configured catalog.
   *
   * `visibleModels` is applied here and not in the request path: a model the
   * selector hides is still addressable by id, because a hidden entry is a UI
   * preference, not a capability statement.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return filterVisibleModels(this.catalog, this.config.visibleModels)
      .map(entry => this.modelInfo(provider, entry))
  }

  /**
   * Resolve one exact model.
   *
   * Resolution is metadata, never admission: the host builds the browser catalog
   * by resolving *every* advertised model, and one throw demotes the whole
   * provider into `failures` — which is exactly how a provider disappears from
   * the model picker. So a model that this route cannot actually run still
   * resolves here, and the turn refuses it with `MODEL_NOT_FOUND` instead
   * (`stream`). Only an id outside the advertised catalog throws.
   */
  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = this.catalog.find(candidate => candidate.id === model)
    if (entry === undefined) {
      throw new LlmError(
        `ZCode does not advertise model "${model}"; the configured catalog is ${this.catalog.map(item => item.id).join(', ')}`,
        'MODEL_NOT_FOUND',
      )
    }
    const info = this.modelInfo(provider, entry)
    return {
      ...info,
      ...(entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } }),
    }
  }

  /**
   * Run one turn through a ZCode process.
   *
   * The generator never throws: every failure is reported as a terminal
   * `finish` chunk carrying the DSH-visible code, so the caller always sees the
   * provider facts this adapter collected.
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, void> {
    // The card's live choice, read once per turn. Only `model` reaches the
    // spawned command: the CLI has no `--effort` flag, and `plan` selects which
    // account ZCode itself signs its own requests with — the command line is
    // identical for both plans, so it must never be read as a transport switch.
    const selection = this.getSelection?.()
    const selectedModel = nonEmpty(selection?.model)
    const model = selectedModel ?? this.model
    // The cli route has no `--model` flag, so a requested model it cannot honor
    // fails here — at the turn — rather than in `resolveModel`, which must
    // advertise every listed model or the host drops the provider from the picker.
    if (options.model !== model) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'MODEL_NOT_FOUND',
            message: `ZCode 0.17.0 has no --model flag, so this route can only run the configured model "${model}"; `
              + `"${options.model}" cannot be selected`,
          },
        },
      }
      return
    }
    const turnOptions = selectedModel === undefined
      ? options
      : { ...options, model }
    const conversationId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const auxiliary = options.purpose !== undefined
    const shared = conversationId !== undefined && !auxiliary
    const release = shared ? await this.sessions.acquire(conversationId) : undefined
    try {
      yield* this.streamTurn(turnOptions, conversationId, shared)
    } finally {
      release?.()
    }
  }

  // -------------------------------------------------------------------------
  // Free-plan turn (app-server channel)
  // -------------------------------------------------------------------------

  /**
   * One turn over the ZCode app-server (start-plan).
   *
   * The wire carries the same account providers the desktop client injects, so
   * the CLI signs its own requests and no credential of this adapter ever
   * leaves the machine. Frames project 1:1 onto StreamChunks: a thinking run
   * opens a `reasoning` block before the text block, usage precedes finish,
   * and every failure surfaces as the same DSH-visible codes the `-p` route
   * uses.
   */
  private async *streamFreeTurn(
    options: GenerateOptions,
    conversationId: string | undefined,
    shared: boolean,
  ): AsyncGenerator<StreamChunk, void, void> {
    const startedAt = Date.now()
    const dataBaseDir = zcodeDataBaseDir()
    const selection = this.getSelection?.()
    const model = nonEmpty(options.model) ?? this.model
    const effort = effortId(selection?.effort) ?? 'max'

    const emitFinish = (
      failure: LlmFailure | undefined,
      usage: TokenUsage | undefined,
      characters: number,
      zcodeSessionId: string,
    ): StreamChunk[] => {
      this.logger({
        kind: failure === undefined ? 'zcode.request.completed' : 'zcode.request.failed',
        provider: this.provider,
        model: this.model,
        transport: 'app-server',
        toolPolicy: this.toolPolicy,
        sharedSession: shared,
        conversationId,
        purpose: options.purpose,
        durationMs: Date.now() - startedAt,
        characters,
        zcodeSessionId,
        code: failure?.code,
        toolSchemas: options.tools?.length ?? 0,
        usage,
      })
      const chunks: StreamChunk[] = []
      if (usage !== undefined) chunks.push({ type: 'usage', usage })
      chunks.push({
        type: 'finish',
        reason: failure === undefined ? { kind: 'stop' } : { kind: 'error', failure },
      })
      return chunks
    }

    // Admission first: the same refusals the `-p` route enforces, before any
    // process exists. The free channel runs its own tools, so a dsh-owned
    // schema list cannot be projected and is refused with the honest code.
    if ((options.tools?.length ?? 0) > 0 && this.toolPolicy === 'dsh-owned') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'UNSUPPORTED_TOOLS',
            message: 'toolPolicy "dsh-owned" is not implemented on the free-plan app-server route: '
              + `it cannot project ${options.tools?.length ?? 0} declared tool(s) back to DSH. `
              + 'Use "zcode-owned" (ZCode runs its own tools) or "reject" (no tools).',
          },
        },
      }
      return
    }
    const unsupported = unsupportedOptions(options)
    if (unsupported.length > 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'UNSUPPORTED_OPTION',
            message: `ZCode 0.17.0's app-server turn has no place for ${unsupported.join(', ')}; `
              + 'this adapter refuses the request instead of silently dropping the setting.',
          },
        },
      }
      return
    }

    const prompt = this.buildPrompt(options, false)
    const recorded = shared && conversationId !== undefined ? this.sessions.get(conversationId) : undefined
    const resumeSessionId = this.config.sessionMode === 'resume' && recorded !== undefined
      ? recorded.sessionId
      : undefined

    let account: ZcodeAccountConfig
    try {
      account = buildZcodeAccountConfig({
        builtinPath: zcodeBuiltinPath(),
        accountType: 'bigmodel',
        mode: 'start-plan',
      })
    } catch (error) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'ZCODE_ENV_MISSING',
            message: 'The start-plan account table could not be built from the built-in provider config: '
              + (error instanceof Error ? error.message : String(error)),
          },
        },
      }
      return
    }

    const appServerDeps: ZcodeAppServerDeps = {
      nodePath: this.processConfig.nodePath,
      zcodeCjsPath: this.processConfig.zcodeCjsPath,
      env: freePlanEnv(),
      workspacePath: await this.resolveCwd(conversationId) ?? '.',
      workspaceKey: conversationId ?? 'adhoc',
      planToken: () => readZcodePlanToken(dataBaseDir),
      logger: (record: unknown) => this.logger(record),
      timeoutMs: this.processConfig.timeoutMs,
      idleTimeoutMs: this.processConfig.idleTimeoutMs,
      maxOutputBytes: this.processConfig.maxOutputBytes,
    }

    const textParts: string[] = []
    const reasoningParts: string[] = []
    let usage: TokenUsage | undefined
    let textOpen = false
    let reasoningOpen = false
    let blockIndex = 0
    let zcodeSessionId = ''
    let failure: LlmFailure | undefined

    try {
      const result = await runZcodeAppServerTurn(appServerDeps, account, {
        providerId: account.providerId,
        modelId: model,
        reasoningLevel: effort,
        prompt,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      zcodeSessionId = result.zcodeSessionId
      if (shared && conversationId !== undefined && zcodeSessionId.length > 0) {
        this.remember(conversationId, zcodeSessionId)
      }
      if (result.terminal !== 'success' && result.errorCode === undefined) {
        failure = { code: 'ZCODE_UNKNOWN', message: 'ZCode app-server turn failed without an error code' }
      } else if (result.terminal !== 'success') {
        failure = {
          code: result.errorCode !== undefined && isZcodeErrorCode(result.errorCode) ? result.errorCode : 'ZCODE_UNKNOWN',
          message: result.errorMessage ?? 'ZCode app-server turn failed',
        }
      }
      for (const frame of result.frames) {
        const text = frame.text
        if (frame.kind === 'thinking' && typeof text === 'string' && text.length > 0) {
          if (!reasoningOpen) {
            reasoningOpen = true
            yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
          }
          reasoningParts.push(text)
          yield { type: 'text-delta', index: blockIndex, text }
        } else if (frame.kind === 'text' && typeof text === 'string' && text.length > 0) {
          if (reasoningOpen) {
            reasoningOpen = false
            yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningParts.join('') } }
            blockIndex += 1
          }
          if (!textOpen) {
            textOpen = true
            yield { type: 'block-start', index: blockIndex, blockType: 'text' }
          }
          textParts.push(text)
          yield { type: 'text-delta', index: blockIndex, text }
        } else if (frame.kind === 'usage' && frame.usage !== undefined) {
          usage = {
            inputTokens: frame.usage.inputTokens,
            outputTokens: frame.usage.outputTokens,
            ...(frame.usage.totalTokens === undefined ? {} : { totalTokens: frame.usage.totalTokens }),
            ...(frame.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: frame.usage.cacheReadTokens }),
            ...(frame.usage.cacheCreationTokens === undefined ? {} : { cacheWriteTokens: frame.usage.cacheCreationTokens }),
          }
        } else if (frame.kind === 'error') {
          failure ??= {
            code: frame.errorCode !== undefined && isZcodeErrorCode(frame.errorCode) ? frame.errorCode : 'ZCODE_UNKNOWN',
            message: frame.errorMessage ?? 'ZCode app-server reported an error',
          }
        }
      }
    } catch (error) {
      if (error instanceof ZcodeError) failure = toLlmFailure(error)
      else {
        failure = {
          code: 'ZCODE_UNKNOWN',
          message: boundDiagnostic(`ZCode app-server turn failed: ${error instanceof Error ? error.message : String(error)}`),
        }
      }
    }

    if (reasoningOpen) {
      yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningParts.join('') } }
      blockIndex += 1
    }
    if (textOpen) {
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: textParts.join('') } }
    }
    for (const chunk of emitFinish(failure, usage, textParts.join('').length, zcodeSessionId)) yield chunk
  }

  // -------------------------------------------------------------------------
  // Turn assembly
  // -------------------------------------------------------------------------

  private async *streamTurn(
    options: GenerateOptions,
    conversationId: string | undefined,
    shared: boolean,
  ): AsyncGenerator<StreamChunk, void, void> {
    // Free plan runs on the app-server channel: the CLI signs start-plan
    // requests itself once the account providers are injected in-process, so
    // no token or key of ours travels on the wire. Paid (and the default) keep
    // the one-shot `-p` subprocess, whose self-signing comes from the
    // personal provider config the CLI reads on its own.
    if (nonEmpty(this.getSelection?.()?.plan) === 'free') {
      yield* this.streamFreeTurn(options, conversationId, shared)
      return
    }
    const startedAt = Date.now()
    const parser = new ZcodeStreamParser()
    const queue: ZcodeFrame[] = []
    let wake: (() => void) | undefined
    let settled = false
    let abortCause: AbortCause | undefined
    let toolFrame: ZcodeToolFrame | undefined
    let sawUnknownFrame = false
    // Bounded whole-capture buffer for {@link recoverWholeSegment}.
    let capture = ''

    // One internal kill switch, driven by three independent reasons: the caller
    // cancelled, a tool-shaped frame needs an approval nobody can give, or the
    // stream carried an in-band error. The process layer kills the whole tree on
    // abort, so a hung child cannot outlive the turn that gave up on it.
    const abort = new AbortController()
    const callerSignal = options.signal
    const onCallerAbort = (): void => {
      abortCause ??= 'caller'
      abort.abort()
    }
    if (callerSignal?.aborted === true) onCallerAbort()
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    const push = (frames: readonly ZcodeFrame[]): void => {
      if (frames.length === 0) return
      for (const frame of frames) {
        if (frame.kind === 'tool') {
          toolFrame ??= frame
          abortCause ??= 'tool'
          abort.abort()
        } else if (frame.kind === 'error') {
          abortCause ??= 'in-band-error'
          abort.abort()
        } else if (frame.kind === 'unknown') {
          sawUnknownFrame = true
        }
      }
      queue.push(...frames)
      wake?.()
      wake = undefined
    }

    // Session lookup happens before the prompt is built: resume mode changes
    // both the argv and the prompt's own scope.
    const recorded = shared && conversationId !== undefined
      ? this.sessions.get(conversationId)
      : undefined
    const resume = this.config.sessionMode === 'resume' && recorded !== undefined

    let failure: LlmFailure | undefined
    const textParts: string[] = []
    let usage: TokenUsage | undefined
    let stopReason: string | undefined
    let textOpen = false

    try {
      const prompt = this.buildPrompt(options, resume)
      failure = this.admissionFailure(options, prompt)
      const cwd = failure === undefined ? await this.resolveCwd(conversationId) : undefined
      if (failure === undefined && cwd === undefined) {
        failure = {
          code: 'WORKSPACE_UNAVAILABLE',
          message: 'The session workspace root could not be resolved through the host workspace registry, '
            + 'so this turn was not started. Running the child in the DSH install directory instead would point '
            + 'ZCode at the wrong project; check that the session has a workspace and that it still exists.',
        }
      }
      if (failure === undefined && prompt.length > PROMPT_ARGV_WARN_CHARS) {
        this.logger({
          kind: 'zcode.prompt.large',
          provider: this.provider,
          characters: prompt.length,
          warnAt: PROMPT_ARGV_WARN_CHARS,
          maxAt: PROMPT_ARGV_MAX_CHARS,
        })
      }

      if (failure === undefined && cwd !== undefined) {
        const run = runZcode({
          config: this.processConfig,
          prompt,
          // Always the session's workspace root, never `process.cwd()`: the child
          // resolves relative paths and edits against the project the user opened.
          cwd,
          passEnv: this.config.passEnv ?? [],
          ...(resume && recorded !== undefined ? { sessionId: recorded.sessionId, resume: true } : {}),
          signal: abort.signal,
          onDiagnostic: (record: unknown) => this.logger(record),
          onStdoutLine: (line: string) => {
            if (capture.length < STDOUT_RECOVERY_MAX_CHARS) capture += `${line}\n`
            push(parser.pushLine(line))
          },
        })
        const outcome = run.then(
          result => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        void outcome.then(() => {
          // A trailing line without a newline is held back by the parser; the
          // process is gone, so half a frame can no longer be completed.
          push(parser.flush())
          settled = true
          wake?.()
          wake = undefined
        })

        while (true) {
          if (queue.length === 0) {
            if (settled) break
            await new Promise<void>(resolve => {
              wake = resolve
            })
            continue
          }
          const frame = queue.shift()
          if (frame === undefined) continue

          switch (frame.kind) {
            case 'text': {
              if (frame.text.length === 0) break
              if (!textOpen) {
                textOpen = true
                yield { type: 'block-start', index: 0, blockType: 'text' }
              }
              textParts.push(frame.text)
              yield { type: 'text-delta', index: 0, text: frame.text }
              break
            }
            case 'usage': {
              usage = toTokenUsage(frame.usage)
              break
            }
            case 'session': {
              // Remembered as soon as it is seen: a turn that fails later still
              // leaves a reusable id, and `resume` is opt-in anyway.
              if (shared && conversationId !== undefined) this.remember(conversationId, frame.sessionId)
              break
            }
            case 'finish': {
              if (frame.stopReason !== undefined) stopReason = frame.stopReason
              break
            }
            case 'error': {
              // Kept for the terminal chunk; the kill switch is already armed.
              this.noteQuotaObservation(frame.error)
              failure ??= toLlmFailure(frame.error)
              break
            }
            default:
              break
          }
        }

        const result = await outcome
        if (failure === undefined) {
          if (toolFrame !== undefined) failure = this.toolFailure(toolFrame)
          else if (!result.ok) failure = this.processFailure(result.error, abortCause, resume, conversationId)
        }
      }
    } finally {
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }

    // Terminal assembly. A started block is always closed, so the assembler
    // never holds an open text block when `finish` arrives.
    if (textOpen) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: textParts.join('') } }
    }

    if (failure === undefined && textParts.join('').trim().length === 0) {
      // A single pretty-printed JSON document has no parseable line, so the live
      // pass sees only unknown frames. Recover the answer from the whole capture
      // before the empty-answer branch turns a good document into a failure.
      const recovered = capture.trim().length === 0 ? undefined : recoverWholeSegment(capture)
      if (recovered !== undefined) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: recovered }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: recovered } }
        textParts.push(recovered)
      }
    }

    if (failure === undefined) {
      const empty = textParts.join('').trim().length === 0
      if (empty) {
        // Never a silent success: an empty answer ends the turn with nothing for
        // the user or the loop to act on.
        failure = sawUnknownFrame
          ? {
              code: 'ZCODE_PARSE',
              message: 'ZCode exited cleanly but its stdout carried no recognizable text frame; '
                + `first bytes: ${parser.rawPreview.slice(0, 192)}`,
            }
          : { code: EMPTY_RESPONSE_CODE, message: 'ZCode completed without producing any output' }
      } else if (isToolStopReason(stopReason)) {
        // A stop reason naming a tool with no tool frame means the CLI ended the
        // turn for a reason this route cannot satisfy.
        failure = {
          code: 'UNSUPPORTED_TOOLS',
          message: `ZCode stopped with "${String(stopReason)}", which this route cannot project: `
            + 'tool execution is not part of the v1 tool policy.',
        }
      }
    }

    this.logger({
      kind: failure === undefined ? 'zcode.request.completed' : 'zcode.request.failed',
      provider: this.provider,
      model: this.model,
      toolPolicy: this.toolPolicy,
      sessionMode: resume ? 'resume' : 'full',
      sharedSession: shared,
      conversationId,
      purpose: options.purpose,
      durationMs: Date.now() - startedAt,
      characters: textParts.join('').length,
      stopReason,
      abortCause,
      code: failure?.code,
      toolSchemas: options.tools?.length ?? 0,
      usage,
    })

    if (usage !== undefined) yield { type: 'usage', usage }
    yield {
      type: 'finish',
      reason: failure === undefined ? stopFinishReason(stopReason) : { kind: 'error', failure },
    }
  }

  // -------------------------------------------------------------------------
  // Failure mapping
  // -------------------------------------------------------------------------

  /**
   * Map one tool-shaped frame onto the fail-closed code that fits it.
   *
   * `permission` means the CLI needs an approval, `tool-call` means the model
   * asked for a tool this route never advertised. They need different fixes,
   * so they get different codes (registered deviation D-a).
   */
  private toolFailure(frame: ZcodeToolFrame): LlmFailure {
    const name = frame.toolName === undefined ? 'unknown tool' : `"${frame.toolName}"`
    if (frame.request === 'permission') {
      return {
        code: 'PERMISSION_REQUIRED',
        message: `ZCode asked for approval to run ${name}. This provider runs headless with toolPolicy "${this.toolPolicy}", `
          + 'so there is no approval channel and the process was stopped; approve the tool in the ZCode client, '
          + 'or run the turn without tools.',
      }
    }
    return {
      code: 'UNSUPPORTED_TOOLS',
      message: `ZCode requested tool ${name}, but toolPolicy "${this.toolPolicy}" keeps DSH tool calls out of this route; `
        + 'the process was stopped instead of leaving the turn waiting for a result nobody can produce.',
    }
  }

  /**
   * Remember a provider-side quota rejection for the diagnostics surface.
   *
   * Recording only: the failure keeps travelling through {@link toLlmFailure}
   * into the terminal `finish` chunk exactly as before, and this cannot throw —
   * the diagnostics layer holds one module-level record. Without this call
   * `doctor`'s `last-quota` check could only ever say "nothing observed in this
   * process", even right after a real 1309.
   */
  private noteQuotaObservation(error: ZcodeError): void {
    if (error.code !== 'QUOTA' || error.providerCode === undefined) return
    const providerCode = String(error.providerCode)
    if (providerCode !== QUOTA_PROVIDER_CODE) return
    recordQuotaObservation({ providerCode, requestId: error.requestId })
  }

  /**
   * Pre-spawn admission: refuse what this route cannot honor instead of letting
   * the CLI ignore it. Every branch here runs before `runZcode`, so a refused
   * request never spends a quota unit or leaves a process behind.
   */
  private admissionFailure(options: GenerateOptions, prompt: string): LlmFailure | undefined {
    if (prompt.length > PROMPT_ARGV_MAX_CHARS) {
      return {
        code: 'ZCODE_UNKNOWN',
        message: `The rendered prompt is ${prompt.length} characters, above the ${PROMPT_ARGV_MAX_CHARS}-character ceiling `
          + 'this route can pass on a Windows command line (32767 total). '
          + 'The ZCode CLI accepts a one-shot prompt only as an argv entry, and this adapter will not truncate history.',
      }
    }
    const unsupported = unsupportedOptions(options)
    if (unsupported.length > 0) {
      return {
        code: 'UNSUPPORTED_OPTION',
        message: `ZCode 0.17.0's one-shot argv form has no place for ${unsupported.join(', ')}; `
          + 'this adapter refuses the request instead of silently dropping the setting. '
          + 'Remove these fields from the request.',
      }
    }
    const toolCount = options.tools?.length ?? 0
    if (toolCount > 0 && this.toolPolicy !== 'zcode-owned') {
      // The CLI route has no way to hand a call back to DSH: zcode.cjs prints
      // tool progress as terminal text and exits, so the schemas go nowhere.
      // Refusing is the only honest answer.
      return this.toolPolicy === 'dsh-owned'
        ? {
            code: 'UNSUPPORTED_TOOLS',
            message: `toolPolicy "dsh-owned" is not implemented on this route: it cannot emit tool-call `
              + `frames, so ${toolCount} declared tool(s) cannot be projected back to DSH. `
              + 'Use "zcode-owned" (ZCode runs its own tools) or "reject" (no tools).',
          }
        : {
            code: 'UNSUPPORTED_TOOLS',
            message: `toolPolicy "reject" refuses ${toolCount} declared tool schema(s) before the process starts: `
              + 'this route cannot project tool calls back to DSH. '
              + 'Use "zcode-owned" (ZCode runs its own tools) or remove the tools from the request.',
          }
    }
    if (this.toolPolicy === 'reject') {
      const media = countMediaBlocks(options.messages)
      if (media > 0) {
        return {
          code: 'UNSUPPORTED_CONTENT',
          message: `toolPolicy "reject" refuses ${media} image/file block(s) before the process starts: `
            + 'this route is text-only, and dropping the attachment silently would answer a different question. '
            + 'Use "zcode-owned" or "dsh-owned" to receive placeholder text for attachments.',
        }
      }
    }
    return undefined
  }

  /**
   * Ask the host for the session workspace root.
   *
   * A missing resolver, a missing session, a deleted directory or a throwing
   * registry all collapse to `undefined`; the caller fails closed with
   * `WORKSPACE_UNAVAILABLE` rather than guessing a directory.
   */
  private async resolveCwd(conversationId: string | undefined): Promise<string | undefined> {
    if (conversationId === undefined || this.resolveWorkspaceRoot === undefined) return undefined
    try {
      const root = await this.resolveWorkspaceRoot(conversationId)
      const trimmed = root?.trim()
      return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
    } catch (error) {
      this.logger({
        kind: 'zcode.workspace.resolve.failed',
        conversationId,
        message: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** Map a process-layer failure, keeping a caller cancellation distinguishable. */
  private processFailure(
    error: unknown,
    abortCause: AbortCause | undefined,
    resume: boolean,
    conversationId: string | undefined,
  ): LlmFailure {
    if (isZcodeError(error)) this.noteQuotaObservation(error)
    const failure = isZcodeError(error) ? toLlmFailure(error) : {
      code: 'ZCODE_UNKNOWN' as const,
      message: error instanceof Error ? error.message : String(error),
    }
    if (abortCause === 'caller') {
      return { code: 'ABORTED', message: 'The ZCode request was cancelled by the caller' }
    }
    if (resume && conversationId !== undefined && DROPS_SESSION_ON.has(failure.code)) {
      // A dead id fails identically on the next attempt, and retrying it in full
      // mode would spend another quota unit on a guess (registered deviation
      // D-b). Drop the record so the next turn starts clean — logging alone left
      // resume mode reusing the dead id forever.
      this.logger({ kind: 'zcode.session.stale', code: failure.code, conversationId })
      try {
        this.sessions.delete(conversationId)
      } catch (forgetError) {
        this.logger({
          kind: 'zcode.session.forget.failed',
          conversationId,
          message: forgetError instanceof Error ? forgetError.message : String(forgetError),
        })
      }
    }
    return failure
  }

  // -------------------------------------------------------------------------
  // Session bookkeeping
  // -------------------------------------------------------------------------

  private remember(conversationId: string, sessionId: string): void {
    try {
      this.sessions.set(conversationId, sessionId)
    } catch (error) {
      // A failed write must not fail the turn: the answer is already in hand.
      this.logger({
        kind: 'zcode.session.persist.failed',
        conversationId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Catalog helpers
  // -------------------------------------------------------------------------

  private modelInfo(provider: string, entry: ModelConfig): LlmModelInfo {
    return {
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: TEXT_ONLY,
    }
  }

  /**
   * Filter the configured retry allowlist down to the codes this route can
   * actually produce, falling back to the defaults when nothing survives.
   */
  private retryableCodes(): string[] {
    const allowed = new Set<string>(ZCODE_RETRYABLE_CODES)
    const configured = (this.config.retryPolicy?.retryableCodes ?? [...ZCODE_RETRYABLE_CODES])
      .filter(code => allowed.has(code))
    return configured.length > 0 ? configured : [...ZCODE_RETRYABLE_CODES]
  }

  // -------------------------------------------------------------------------
  // Prompt projection
  // -------------------------------------------------------------------------

  /**
   * Render the request as the single prompt string the CLI accepts.
   *
   * `resume` narrows the scope to the messages produced after this route's own
   * last assistant message: the resumed ZCode session already holds everything
   * up to and including that answer, so resending it would duplicate the whole
   * conversation inside the model's context.
   */
  private buildPrompt(options: GenerateOptions, resume: boolean): string {
    const messages = resume ? this.turnAfterOwnAssistant(options.messages) : options.messages
    const sections: string[] = []
    if (options.system !== undefined && options.system.trim().length > 0) {
      sections.push(`# 系统提示\n${options.system}`)
    }
    if (messages !== options.messages) {
      sections.push('# 会话历史已由 ZCode 会话保存，下面仅是本轮新增内容')
    }
    for (const message of messages) {
      const body = renderContent(message.content).trim()
      if (body.length === 0) continue
      sections.push(`${roleHeading(message)}:\n${body}`)
    }
    return sections.join('\n\n')
  }

  /** Messages after this route's last assistant answer; the whole list when there is none. */
  private turnAfterOwnAssistant(messages: readonly RequestMessage[]): readonly RequestMessage[] {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message === undefined || message.role !== 'assistant') continue
      if (message.source.kind !== 'model') continue
      if (message.source.provider !== this.provider) continue
      return messages.slice(index + 1)
    }
    return messages
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Codes that mean the remembered session id is unusable.
 *
 * `QUOTA`, `RATE_LIMIT`, `AUTH`, `TIMEOUT` and `ABORTED` all describe the
 * account or the transport, so the id stays: dropping it would throw away a
 * still-valid session because of a transient condition.
 *
 * `ZCODE_PARSE` is deliberately absent. It is produced only by the clean-exit
 * branch that saw no recognizable text frame, and the process layer never
 * raises it, so `processFailure` cannot observe it at all. A clean exit leaves
 * the server-side session intact — the gap is in this parser, which has never
 * seen a successful stdout (finding F-1) — so forgetting the id there would
 * destroy a session nothing proves broken.
 */
const DROPS_SESSION_ON: ReadonlySet<string> = new Set(['ZCODE_EXIT', 'ZCODE_UNKNOWN'])

/**
 * Request fields this route has no place for, rendered for the failure
 * message. `stop: []` is a no-op and therefore accepted.
 */
function unsupportedOptions(options: GenerateOptions): string[] {
  const found: string[] = []
  if (options.temperature !== undefined) found.push(`temperature=${String(options.temperature)}`)
  if (options.maxTokens !== undefined) found.push(`maxTokens=${String(options.maxTokens)}`)
  if (options.stop !== undefined && options.stop.length > 0) found.push(`stop=${JSON.stringify(options.stop)}`)
  return found
}

/** Number of image/file blocks anywhere in the request history. */
function countMediaBlocks(messages: readonly RequestMessage[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' || block.type === 'file') count += 1
    }
  }
  return count
}

/** Heading of one transcript message. The CLI sees plain text, so roles must be labeled. */
function roleHeading(message: RequestMessage): string {
  switch (message.role) {
    case 'system': return '# 系统提示'
    case 'developer': return '# 系统更新'
    case 'user': return '## 用户'
    case 'assistant': return '## 助手'
    case 'tool': {
      const outcome = message.isError === true ? '，失败' : ''
      return `## 工具结果（调用 ${String(message.toolCallId)}${outcome}）`
    }
    default: return '## 消息'
  }
}

/**
 * Flatten one content array into transcript text.
 *
 * Every block projects to text because this route is text-only: an image
 * becomes a placeholder naming its dimensions and byte size (registered
 * deviation D-c), and reasoning is wrapped in tags so a later turn can tell it
 * apart from the answer itself.
 */
function renderContent(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        parts.push(block.text)
        break
      }
      case 'reasoning': {
        parts.push(`<thinking>${block.text}</thinking>`)
        break
      }
      case 'tool-call': {
        parts.push(`[工具调用 ${block.name}] ${block.arguments}`)
        break
      }
      case 'image': {
        const name = block.attachment.name ?? String(block.attachment.attachmentId)
        const size = `${block.attachment.width}×${block.attachment.height}, ${block.attachment.bytes} bytes`
        parts.push(`[图片附件 ${name} (${size})：本路由为纯文本，图片内容未发送]`)
        break
      }
      case 'file': {
        parts.push(`[文件附件 ${block.attachment.name} (${block.attachment.bytes} bytes)：本路由为纯文本，文件内容未发送]`)
        break
      }
      case 'tool-addition': {
        parts.push(`[工具可用: ${block.toolName}]`)
        break
      }
      case 'tool-removal': {
        parts.push(`[工具移除: ${block.toolName}]`)
        break
      }
      default: {
        break
      }
    }
  }
  return parts.join('\n')
}

/** Project one parsed usage frame onto the disjoint DSH counters. */
function toTokenUsage(usage: ZcodeTokenUsage): TokenUsage {  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

/**
 * Map a provider error onto the DSH failure shape.
 *
 * DSH's `LlmFailure` has no field for a provider code or a request id (and its
 * request id is branded, so it cannot be constructed here), yet those two are
 * exactly what makes a ZCode failure actionable. They are therefore folded into
 * the message, which every consumer renders.
 */
function toLlmFailure(error: ZcodeError): LlmFailure {
  const details: string[] = []
  if (error.providerCode !== undefined) details.push(`providerCode=${error.providerCode}`)
  if (error.providerMessage !== undefined) details.push(`providerMessage=${error.providerMessage}`)
  if (error.responseStatus !== undefined) details.push(`responseStatus=${error.responseStatus}`)
  if (error.requestId !== undefined) details.push(`request-id=${error.requestId}`)
  if (error.stderrTail !== undefined) details.push(`stderr=${error.stderrTail}`)
  const rendered = details.length === 0 ? error.message : `${error.message} (${details.join('; ')})`
  return {
    code: error.code,
    // Third-party text reaches logs and the transcript: redact credentials and
    // cap the total, or one upstream dump can flood both.
    message: boundDiagnostic(rendered),
    ...(error.responseStatus === undefined ? {} : { status: error.responseStatus }),
  }
}

/** Success-side finish reason; a length stop is the only provider reason with a DSH equivalent. */
function stopFinishReason(stopReason: string | undefined): FinishReason {
  const normalized = (stopReason ?? '').toLowerCase()
  if (normalized.includes('length') || normalized.includes('max_token') || normalized.includes('max-token')) {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}

/** Whether a provider stop reason names a tool, i.e. a turn this route cannot complete. */
function isToolStopReason(stopReason: string | undefined): boolean {
  return (stopReason ?? '').toLowerCase().includes('tool')
}

/** Trimmed value, or `undefined` for a blank one. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Re-export so consumers of this module need one import for the error type. */
export { ZcodeError, isZcodeError }

// ---------------------------------------------------------------------------
// Free-plan wiring helpers
// ---------------------------------------------------------------------------

/**
 * The data root the app-server child must share with the CLI's own state:
 * `ZCODE_DATA_BASE_DIR`, resolved against the same contract the spawn layer
 * enforces. Empty means the host never supplied the variable, which the
 * credential reader will surface as `ZCODE_CREDENTIAL_MISSING` at request
 * time — an honest late failure beats guessing a path.
 */
function zcodeDataBaseDir(): string {
  return nonEmpty(process.env['ZCODE_DATA_BASE_DIR']) ?? nonEmpty(process.env['ZCODE_DATA_BASE_DIR'.toLowerCase()]) ?? ''
}

/**
 * The built-in provider table the account injection is built from. This must
 * be the canonical resource path — the runtime-cached copy under
 * `runtime/provider/…` silently no-ops the injection (probe evidence
 * 2026-10-25), and the spawn contract already pins the resource location.
 */
function zcodeBuiltinPath(): string {
  return nonEmpty(process.env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'])
    ?? 'F:\\AgentData\\zcode\\cli\\resources\\config\\provider\\zcode-builtin.json'
}

/**
 * Environment for the app-server child: the same contract values the `-p`
 * route checks, passed explicitly because the injected account table must
 * point at the canonical builtin path (not the runtime cache) for the
 * injection to reach the provider registry.
 */
function freePlanEnv(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {}
  const pick = (name: string): void => {
    const value = nonEmpty(process.env[name])
    if (value !== undefined) env[name] = value
  }
  pick('ZCODE_HOME')
  pick('ZCODE_DATA_BASE_DIR')
  pick('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE')
  pick('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE')
  pick('NODE_OPTIONS')
  return env
}

/** The card's effort pick, narrowed to a known upstream id. */
function effortId(value: string | undefined): string | undefined {
  return typeof value === 'string' && (ZCODE_EFFORT_IDS as readonly string[]).includes(value) ? value : undefined
}
