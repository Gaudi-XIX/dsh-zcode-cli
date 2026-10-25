/**
 * The ZCode app-server channel (`zcode.cjs app-server --stdio`).
 *
 * One child process speaks a line-delimited JSON protocol with no `jsonrpc`
 * field (a line carrying `jsonrpc:"2.0"` is rejected with -32600):
 *
 * - `{id, result|error}` — a response to one of our requests;
 * - `{id, method, params}` — a CLI→host callback that MUST be answered with
 *   `{id, result}`, or the turn fails;
 * - everything else — an event.
 *
 * A turn is: spawn → wait-ready by polling `provider/refreshRegistry` (never
 * by watching stdout) → `provider/updateAccountConfig` → `refreshRegistry` →
 * `session/create` (or `session/resume`) → `session/subscribe` →
 * `session/send` → collect frames until the terminal event → tear down.
 *
 * Credential red line: the plan token flows only through the
 * `interaction/requestProviderRuntimeHeaders` answer. It is never logged,
 * never placed into an error, never returned in a frame.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

import { ZcodeError } from '../provider/error-codes.js'
import { terminateProcessTree } from './process.js'

/** One projected output frame, in arrival order. */
export interface ZcodeAppServerFrame {
  readonly kind: 'text' | 'thinking' | 'usage' | 'finish' | 'error' | 'unknown'
  readonly text?: string
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly totalTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheCreationTokens?: number
  }
  readonly stopReason?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly raw?: string
}

export interface ZcodeAppServerDeps {
  readonly nodePath: string
  readonly zcodeCjsPath: string
  readonly env: Readonly<Record<string, string>>
  readonly workspacePath: string
  readonly workspaceKey: string
  /** Fetched fresh on every model-request header callback (token may rotate). */
  readonly planToken: () => string
  readonly logger?: ((record: unknown) => void) | undefined
  readonly spawn?: typeof import('node:child_process').spawn
  readonly timeoutMs?: number
  readonly idleTimeoutMs?: number
  readonly maxOutputBytes?: number
  /** Injectable sleep for tests: microtask-scheduled waits stay off the real
   * timer wheel, so a 60-probe readiness loop can't interact with the test
   * runner's timer bookkeeping (the OOM in `tests/app-server.test.mjs`). */
  readonly delay?: ((ms: number) => Promise<void>) | undefined
  /** Injectable process-tree teardown (defaults to the real taskkill helper). */
  readonly terminateProcessTree?: ((child: import('node:child_process').ChildProcess, log: (record: unknown) => void) => void | Promise<void>) | undefined
}

export interface ZcodeAppServerTurnRequest {
  /** The injected providerId (`buildZcodeAccountConfig().providerId`). */
  readonly providerId: string
  readonly modelId: string
  readonly reasoningLevel: string
  readonly prompt: string
  readonly resumeSessionId?: string
  readonly signal?: AbortSignal
}

export interface ZcodeAppServerTurnResult {
  readonly frames: readonly ZcodeAppServerFrame[]
  readonly zcodeSessionId: string
  readonly terminal: 'success' | 'failed'
  readonly errorCode?: string
  readonly errorMessage?: string
}

export interface ZcodeAppServerSettings {
  readonly thoughtLevels: readonly string[]
  readonly available: readonly { providerId: string; modelId: string }[]
}

/** Minimal wire-message view. */
interface WireMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

/** Observed fields of a `session/event` params object (all optional). */
interface EventParams {
  type?: unknown
  payload?: {
    kind?: unknown
    delta?: unknown
    done?: unknown
    status?: unknown
    errorCode?: unknown
    errorMessage?: unknown
    tokenCount?: unknown
    response?: unknown
    resultType?: unknown
    usage?: unknown
    duration?: unknown
    error?: { code?: unknown; message?: unknown; type?: unknown }
  }
  // The live terminal event carries these at params top level (locked by the
  // one real call recorded in `appserver-events.jsonl`).
  status?: unknown
  errorCode?: unknown
  errorMessage?: unknown
  tokenCount?: unknown
  usage?: unknown
  durationMs?: unknown
}

interface PendingRequest {
  readonly method: string
  resolve: (message: WireMessage) => void
  reject: (cause: unknown) => void
  timer: NodeJS.Timeout
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const READY_POLL_INTERVAL_MS = 250
const READY_POLL_ATTEMPTS = 60
const READY_POLL_TIMEOUT_MS = 800
const KILL_GRACE_MS = 3_000

function fail(code: ZcodeAppServerErrorCode, message: string, cause?: unknown): ZcodeError {
  return new ZcodeError(code, message, cause === undefined ? {} : { cause })
}

/** The codes this module raises (all already in `ZCODE_ERROR_CODES`). */
type ZcodeAppServerErrorCode = 'ZCODE_EXIT' | 'TIMEOUT' | 'ZCODE_PARSE' | 'ZCODE_UNKNOWN' | 'ABORTED'

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * One managed app-server process. All protocol traffic lives here; both the
 * turn runner and the settings probe drive it through the small public surface.
 */
class AppServerSession {
  readonly child: ChildProcess
  private readonly pending = new Map<number, PendingRequest>()
  private readonly frames: ZcodeAppServerFrame[] = []
  private readonly maxOutputBytes: number
  private readonly timeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly signal: AbortSignal | undefined
  private readonly deps: ZcodeAppServerDeps

  sessionId: string | undefined
  thoughtLevels: string[] = []
  available: { providerId: string; modelId: string }[] = []
  terminal: { status: 'success' | 'failed'; errorCode?: string; errorMessage?: string } | undefined

  private nextId = 1
  private stdoutBuffer = ''
  private outputBytes = 0
  private stderrTail = ''
  private killed = false
  private failure: ZcodeError | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private onAbort = (): void => {
    this.setFailure(fail('ABORTED', 'ZCode app-server request aborted'))
  }

  constructor(deps: ZcodeAppServerDeps, signal: AbortSignal | undefined) {
    this.deps = deps
    this.signal = signal
    this.maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    const spawnFn = deps.spawn ?? nodeSpawn
    try {
      this.child = spawnFn(deps.nodePath, [deps.zcodeCjsPath, 'app-server', '--stdio'], {
        env: { ...deps.env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      throw fail('ZCODE_EXIT', `Unable to spawn ZCode app-server: ${errorText(cause)}`, cause)
    }
    signal?.addEventListener('abort', this.onAbort, { once: true })

    // The offline tests inject a fake child whose streams are plain strings, so
    // `setEncoding` is called defensively: a real ChildProcess has it, the fake
    // does not, and the data handler accepts both strings and Buffers.
    if (typeof (this.child.stdout as { setEncoding?: unknown } | null)?.setEncoding === 'function') {
      this.child.stdout?.setEncoding('utf8')
    }
    this.child.stdout?.on('data', (chunk: string | Buffer) => { this.onStdout(typeof chunk === 'string' ? chunk : String(chunk)) })
    if (typeof (this.child.stderr as { setEncoding?: unknown } | null)?.setEncoding === 'function') {
      this.child.stderr?.setEncoding('utf8')
    }
    this.child.stderr?.on('data', (chunk: string | Buffer) => {
      this.stderrTail = (this.stderrTail + (typeof chunk === 'string' ? chunk : String(chunk))).slice(-2_048)
    })
    this.child.once('error', (cause: Error) => {
      this.setFailure(fail('ZCODE_EXIT', `ZCode app-server failed to start: ${errorText(cause)}`, cause))
    })
    this.child.once('exit', (code, signalName) => {
      if (this.failure !== undefined) return
      const detail = stderrTailOf(this.stderrTail)
      this.setFailure(fail(
        'ZCODE_EXIT',
        `ZCode app-server exited unexpectedly (code ${code === null ? 'unknown' : String(code)}${signalName === null ? '' : `, signal ${signalName}`})${detail}`,
      ))
    })
    this.armIdle()
  }

  private onStdout(chunk: string): void {
    if (this.failure !== undefined) return
    this.outputBytes += Buffer.byteLength(chunk)
    if (this.outputBytes > this.maxOutputBytes) {
      this.setFailure(fail('ZCODE_UNKNOWN', `ZCode app-server output exceeded ${this.maxOutputBytes} bytes`))
      return
    }
    this.stdoutBuffer += chunk
    let newline: number
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.length === 0) continue
      let message: WireMessage
      try {
        message = JSON.parse(line) as WireMessage
      } catch {
        this.setFailure(fail('ZCODE_PARSE', 'ZCode app-server stdout line is not JSON'))
        return
      }
      this.armIdle()
      if (message.id !== undefined && message.method === undefined) {
        this.settlePending(message)
      } else if (message.id !== undefined && typeof message.method === 'string') {
        this.answerCallback(message)
      } else {
        this.handleEvent(line, message)
      }
    }
  }

  private settlePending(message: WireMessage): void {
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) {
      const code = typeof message.error.code === 'number' ? message.error.code : undefined
      const text = typeof message.error.message === 'string' ? message.error.message : 'unknown error'
      entry.reject(fail('ZCODE_UNKNOWN', `ZCode app-server rejected ${entry.method} (${code ?? 'error'}): ${truncate(text, 300)}`))
    } else {
      entry.resolve(message)
    }
  }

  private sendLine(message: object): boolean {
    const stdin = this.child.stdin
    if (stdin === null || stdin.destroyed || this.killed) return false
    try {
      stdin.write(`${JSON.stringify(message)}\n`)
      return true
    } catch {
      return false
    }
  }

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<WireMessage> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(fail('TIMEOUT', `ZCode app-server request timed out: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      if (!this.sendLine({ id, method, params })) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(this.failure ?? fail('ZCODE_EXIT', 'ZCode app-server stdin is closed'))
      }
    })
  }

  private answerCallback(message: WireMessage): void {
    const method = message.method ?? ''
    const id = message.id
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      // The only place the plan token leaves the credential module. The answer
      // is the `headersApplied:true` branch of the CLI's strict schema.
      let apiKey: string
      try {
        apiKey = this.deps.planToken()
      } catch (cause) {
        // Credential errors bubble up untouched (own code, never wrapped);
        // the turn dies before further protocol traffic.
        this.setFailure(cause instanceof Error ? cause : fail('ZCODE_UNKNOWN', 'planToken() failed'))
        this.sendLine({ id, result: { headersApplied: false, errorMessage: 'plan token unavailable' } })
        return
      }
      if (!this.sendLine({
        id,
        result: {
          headersApplied: true,
          requestAuth: {
            apiKey,
            headers: { 'http-referer': 'https://zcode.z.ai', 'x-title': 'Z Code@cli' },
          },
        },
      })) {
        this.setFailure(fail('ZCODE_EXIT', 'cannot answer requestProviderRuntimeHeaders: stdin closed'))
      }
      return
    }
    if (method === 'session/requestRuntimePreferences') {
      this.sendLine({
        id,
        result: {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
          modelContextBudgetStrategy: 'preflight-v1',
        },
      })
      return
    }
    this.log({ kind: 'zcode.appserver.callback.unhandled', method })
    // Unknown callbacks get a minimal ack so the turn is not blocked on them.
    this.sendLine({ id, result: {} })
  }

  private handleEvent(line: string, message: WireMessage): void {
    const params = (message.params ?? {}) as EventParams
    const payload = (params.payload ?? {}) as NonNullable<EventParams['payload']>
    // The live wire carries the part kind EITHER at `params.kind` (telemetry
    // envelope: v4/telemetry/event …) or at `params.payload.kind` (session/event
    // streaming). Read both.
    const paramsKind = (params as { kind?: unknown }).kind
    let kind = typeof paramsKind === 'string' && paramsKind.length > 0 ? paramsKind : payload.kind
    // `v4/telemetry/event` names the event in `params.type`, not `kind`
    // (live capture 2026-10-25: kind/status sit at the params top level there).
    if ((kind === undefined || kind === null) && typeof params.type === 'string' && params.type.startsWith('turn.')) {
      kind = params.type
    }

    // Terminal: the CLI emits a turn.terminal event whose kind/status sit at the
    // envelope top level (v4/telemetry/event) or inside `payload` (session/event
    // alternates: turn.completed / turn.failed). Locked against the live wire in
    // `appserver-events.jsonl`.
    const isTerminal = kind === 'turn.terminal'
      || params.type === 'turn.terminal'
      || params.type === 'turn.completed'
      || params.type === 'turn.failed'
    if (isTerminal) {
      const rawStatus = firstString(payload.status, params.status, payload.resultType)
      const status: 'success' | 'failed' = rawStatus === 'success' ? 'success' : 'failed'
      const payloadError = payload.error
      const errorCode = firstString(payload.errorCode, params.errorCode, payloadError?.code, payloadError?.type)
      const errorMessage = firstString(payload.errorMessage, params.errorMessage, payloadError?.message)
      this.terminal = {
        status,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
      }
      // The session/event terminal carries the provider usage in its payload
      // (live capture: `{usage:{inputTokens,outputTokens,totalTokens,…}}`); the
      // telemetry envelope carries only a token total. Prefer the detailed one.
      const u = payload.usage
      if (u !== null && typeof u === 'object') {
        const rec = u as Record<string, unknown>
        const inputTokens = typeof rec['inputTokens'] === 'number' ? rec['inputTokens'] : 0
        const outputTokens = typeof rec['outputTokens'] === 'number' ? rec['outputTokens'] : 0
        const totalTokens = typeof rec['totalTokens'] === 'number' ? rec['totalTokens'] : undefined
        const cacheReadTokens = typeof rec['cacheReadTokens'] === 'number' ? rec['cacheReadTokens'] : undefined
        const cacheWriteTokens = typeof rec['cacheWriteTokens'] === 'number' ? rec['cacheWriteTokens'] : undefined
        if (inputTokens > 0 || outputTokens > 0) {
          this.frames.push({
            kind: 'usage',
            usage: {
              inputTokens,
              outputTokens,
              ...(totalTokens === undefined ? {} : { totalTokens }),
              ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
              ...(cacheWriteTokens === undefined ? {} : { cacheCreationTokens: cacheWriteTokens }),
            },
          })
        } else {
          const tokenCount = typeof payload.tokenCount === 'number' ? payload.tokenCount
            : typeof (params as { tokenCount?: unknown }).tokenCount === 'number'
              ? (params as { tokenCount: number }).tokenCount
            : undefined
          if (tokenCount !== undefined && tokenCount > 0) {
            this.frames.push({ kind: 'usage', usage: { inputTokens: 0, outputTokens: tokenCount, totalTokens: tokenCount } })
          }
        }
      }
      return
    }
    if (kind === 'turn.started' || params.type === 'turn.started') return

    if (kind === 'model.streaming' || params.type === 'model.streaming') {
      const delta = firstString(payload.delta, (params as { delta?: unknown }).delta)
      if (typeof delta === 'string' && delta.length > 0) {
        // `kind` here is the part kind (text_delta / reasoning_delta / tool_input_* …).
        const partKind = kind === 'model.streaming' || kind === undefined ? readPartKind(payload) : kind
        if (partKind === 'reasoning_delta') {
          this.frames.push({ kind: 'thinking', text: delta })
        } else {
          this.frames.push({ kind: 'text', text: delta })
        }
      }
      return
    }
    // Everything else (session.updated, titleUpdated, tool.updated, …) does not
    // project into frames.
  }

  private armIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.setFailure(fail('TIMEOUT', `ZCode app-server idle for ${this.idleTimeoutMs}ms`))
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  private setFailure(cause: ZcodeError | Error): void {
    if (this.failure !== undefined) return
    this.failure = cause instanceof ZcodeError ? cause : fail('ZCODE_UNKNOWN', errorText(cause))
    this.kill()
  }

  private kill(): void {
    if (this.killed) return
    this.killed = true
    ;(this.deps.terminateProcessTree ?? terminateProcessTree)(this.child, record => this.log({ kind: 'zcode.appserver.taskkill', record }))
    setTimeout(() => {
      try {
        this.child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS).unref?.()
  }

  private log(record: unknown): void {
    try {
      this.deps.logger?.(record)
    } catch {
      // A throwing logger must not break the channel.
    }
  }

  /** Resolve via the injected delay when present (tests), else a real timer. */
  private pause(ms: number): Promise<void> {
    if (this.deps.delay !== undefined) return this.deps.delay(ms)
    return sleep(ms)
  }

  /** Wait until the registry answers — never judge readiness from stdout. */
  async waitReady(): Promise<void> {
    for (let attempt = 0; attempt < READY_POLL_ATTEMPTS; attempt += 1) {
      if (this.failure !== undefined) throw this.failure
      if (this.signal?.aborted === true) throw fail('ABORTED', 'ZCode app-server request aborted')
      try {
        const reply = await this.request('provider/refreshRegistry', { reason: 'probe' }, READY_POLL_TIMEOUT_MS)
        const result = reply.result as { refreshed?: unknown } | undefined
        if (result?.refreshed === true) return
      } catch (cause) {
        if (cause instanceof ZcodeError && cause.code === 'TIMEOUT') {
          // Not up yet; poll again.
        } else {
          throw cause
        }
      }
      await this.pause(READY_POLL_INTERVAL_MS)
    }
    throw fail('TIMEOUT', `ZCode app-server did not become ready within ${READY_POLL_ATTEMPTS} readiness probes`)
  }

  async inject(account: { readonly updateParams: unknown }): Promise<void> {
    const reply = await this.request('provider/updateAccountConfig', account.updateParams)
    const result = reply.result as { status?: unknown; receivedRevision?: unknown } | undefined
    this.log({ kind: 'zcode.appserver.injected', status: result?.status, receivedRevision: result?.receivedRevision })
    await this.request('provider/refreshRegistry', { reason: 'settings:settings-manual' })
  }

  async openSession(resumeSessionId: string | undefined): Promise<void> {
    const workspace = { workspacePath: this.deps.workspacePath, workspaceKey: this.deps.workspaceKey }
    const reply = resumeSessionId !== undefined
      ? await this.request('session/resume', { sessionId: resumeSessionId, workspace })
      : await this.request('session/create', { workspace })
    const result = reply.result as {
      session?: { sessionId?: unknown; settings?: {
        thoughtLevel?: { available?: { value?: unknown }[] }
        model?: { available?: { ref?: { providerId?: unknown; modelId?: unknown } }[] }
      } }
    } | undefined
    const sessionId = result?.session?.sessionId ?? (resumeSessionId !== undefined ? resumeSessionId : undefined)
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw fail('ZCODE_UNKNOWN', 'ZCode app-server did not return a sessionId')
    }
    this.sessionId = sessionId
    this.thoughtLevels = (result?.session?.settings?.thoughtLevel?.available ?? [])
      .map(entry => entry?.value)
      .filter((value): value is string => typeof value === 'string')
    this.available = (result?.session?.settings?.model?.available ?? [])
      .map(entry => ({
        providerId: typeof entry?.ref?.providerId === 'string' ? entry.ref.providerId : '',
        modelId: typeof entry?.ref?.modelId === 'string' ? entry.ref.modelId : '',
      }))
      .filter(entry => entry.providerId.length > 0 && entry.modelId.length > 0)
  }

  async send(prompt: string, request: { readonly providerId: string; readonly modelId: string; readonly reasoningLevel: string }): Promise<void> {
    if (this.sessionId === undefined) throw fail('ZCODE_UNKNOWN', 'session/send before session/create')
    await this.request('session/subscribe', { sessionId: this.sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: false })
    await this.request('session/send', {
      sessionId: this.sessionId,
      content: prompt,
      modelSelection: {
        providerId: request.providerId,
        modelId: request.modelId,
        options: { reasoningLevel: request.reasoningLevel },
      },
    })
  }

  /** Resolve when the terminal event arrived, the process died, or we aborted. */
  async waitForTerminal(): Promise<void> {
    while (this.terminal === undefined && this.failure === undefined) {
      if (this.signal?.aborted === true) throw fail('ABORTED', 'ZCode app-server request aborted')
      await this.pause(50)
    }
    if (this.failure !== undefined && this.terminal === undefined) throw this.failure
  }

  readonly framesSnapshot = (): readonly ZcodeAppServerFrame[] => [...this.frames]

  close(): void {
    if (this.sessionId !== undefined && !this.killed && this.failure === undefined) {
      // Best effort; the child is torn down right after regardless.
      try {
        void this.request('session/close', { sessionId: this.sessionId }, 1_000).catch(() => undefined)
      } catch {
        // Ignore — teardown follows immediately.
      }
    }
    this.signal?.removeEventListener('abort', this.onAbort)
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(this.failure ?? fail('ZCODE_EXIT', 'ZCode app-server session was torn down'))
    }
    this.pending.clear()
    this.kill()
  }
}

function readPartKind(payload: NonNullable<EventParams['payload']>): string | undefined {
  const value = (payload as { kind?: unknown })['kind']
  return typeof value === 'string' ? value : undefined
}

function stderrTailOf(tail: string): string {
  const trimmed = tail.trim()
  return trimmed.length === 0 ? '' : `: ${truncate(trimmed, 300)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Run one full turn through the app-server channel.
 *
 * @throws ZcodeError `ABORTED` (before spawn or when the signal fires),
 * `TIMEOUT` (wall clock, idle, per-request), `ZCODE_PARSE` (non-JSON stdout
 * line), `ZCODE_EXIT` (unexpected process exit or spawn failure), or
 * `ZCODE_UNKNOWN` (JSON-RPC error reply). A `planToken()` credential error is
 * re-thrown untouched — its own code, never wrapped.
 */
export async function runZcodeAppServerTurn(
  deps: ZcodeAppServerDeps,
  account: { readonly updateParams: unknown },
  request: ZcodeAppServerTurnRequest,
): Promise<ZcodeAppServerTurnResult> {
  if (request.signal?.aborted === true) {
    throw fail('ABORTED', 'ZCode app-server request aborted before start')
  }
  const session = new AppServerSession(deps, request.signal)
  try {
    await session.waitReady()
    await session.inject(account)
    await session.openSession(request.resumeSessionId)
    await session.send(request.prompt, request)
    await session.waitForTerminal()
    const terminal = session.terminal
    if (terminal === undefined) {
      throw fail('ZCODE_UNKNOWN', 'ZCode app-server turn ended without a terminal event')
    }
    return {
      frames: session.framesSnapshot(),
      zcodeSessionId: session.sessionId ?? '',
      terminal: terminal.status,
      ...(terminal.errorCode === undefined ? {} : { errorCode: terminal.errorCode }),
      ...(terminal.errorMessage === undefined ? {} : { errorMessage: terminal.errorMessage }),
    }
  } finally {
    session.close()
  }
}

/**
 * Read-only probe for the settings card: spawn, inject, create, read the
 * thoughtLevel directory and the available model list, then close.
 */
export async function probeZcodeAppServerSettings(
  deps: ZcodeAppServerDeps,
  account: { readonly updateParams: unknown },
): Promise<ZcodeAppServerSettings> {
  const session = new AppServerSession(deps, undefined)
  try {
    await session.waitReady()
    await session.inject(account)
    await session.openSession(undefined)
    return { thoughtLevels: session.thoughtLevels, available: session.available }
  } finally {
    session.close()
  }
}
