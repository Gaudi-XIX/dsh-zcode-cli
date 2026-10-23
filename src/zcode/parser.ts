/**
 * Standard-output parser of the ZCode provider.
 *
 * ZCode 0.17.0 prints its answer to stdout when `--json` is passed, and
 * *nothing at all* to stdout when it fails (failures go to stderr as human text
 * — see `error-codes.ts`). What the successful stdout actually looks like is
 * still unproven: the only run that could have shown it returned
 * `providerCode 1309` (Coding Plan expired), so both plausible shapes are
 * supported here and a real sample — once a subscription exists — only tightens
 * the recognizer, it does not change this module's contract:
 *
 * 1. **line-incremental** (NDJSON): each stdout line is one JSON frame, so text
 *    deltas can be yielded while the child is still running;
 * 2. **whole-segment**: the entire stdout is one JSON document (pretty-printed
 *    or not), which only yields a single delta at the end.
 *
 * The one invariant that holds for both shapes, and the reason this module
 * exists at all: **empty or unrecognized stdout is never a success**. A run that
 * produced no text frame and no error frame raises `ZCODE_PARSE` carrying the
 * head of the raw output, so a broken shape surfaces as a provider failure
 * instead of an empty assistant turn.
 *
 * Frame *order* is not decided here. This module yields text/usage/session
 * facts in arrival order; `provider/zcode.ts` owns the `StreamChunk` sequence
 * (`block-start → text-delta* → block-end → usage? → finish`).
 */
import { ZcodeError, boundStderrTail, classifyStderr } from '../provider/error-codes.js'

/** Prefix of a ZCode session id, e.g. `sess_477143eb-6589-4e57-936c-800e3fd975e6`. */
export const ZCODE_SESSION_ID_PREFIX = 'sess_'

/** How much raw stdout a `ZCODE_PARSE` error keeps for diagnostics. */
export const PARSE_PREVIEW_MAX_CHARS = 512

/** Token counters as ZCode reports them, before mapping onto `dsh-llm`'s `TokenUsage`. */
export interface ZcodeTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** A normalized stdout frame. */
export type ZcodeFrame =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'usage'; readonly usage: ZcodeTokenUsage }
  | { readonly kind: 'finish'; readonly stopReason: string | undefined }
  | { readonly kind: 'tool'; readonly toolName: string | undefined; readonly request: ZcodeToolRequestKind }
  | { readonly kind: 'error'; readonly error: ZcodeError }
  | { readonly kind: 'unknown'; readonly raw: string }

/** What a tool-shaped frame asks for; decides which fail-closed code the adapter raises. */
export type ZcodeToolRequestKind = 'tool-call' | 'permission'

/**
 * Frame-type words accepted for each family.
 *
 * The lists are deliberately generous and the words are matched after
 * normalizing `_` to `-`: this is a *recognizer for an unproven shape*, so it
 * prefers accepting a slightly odd spelling over dropping a real frame on the
 * floor. Nothing here is allowed to turn an unrecognized frame into text — an
 * unknown frame is recorded as `unknown` and only fails the run if no text
 * frame ever arrived (see `parseStdout`).
 */
const TEXT_FRAME_TYPES: ReadonlySet<string> = new Set([
  'text',
  'text-delta',
  'content-block-delta',
  'content-block',
  'assistant',
  'message',
  'message-delta',
  'result',
  'output',
  'output-text',
  'delta',
  'response',
])

const SESSION_FRAME_TYPES: ReadonlySet<string> = new Set([
  'session',
  'session-init',
  'session-start',
  'session-created',
  'init',
  'system',
  'start',
])

const USAGE_FRAME_TYPES: ReadonlySet<string> = new Set([
  'usage',
  'stats',
  'step-finish',
  'message-stop',
  'message-usage',
])

const FINISH_FRAME_TYPES: ReadonlySet<string> = new Set([
  'finish',
  'done',
  'stop',
  'complete',
  'completed',
  'end',
  'message-complete',
])

const ERROR_FRAME_TYPES: ReadonlySet<string> = new Set(['error', 'failure', 'provider-error', 'turn-error'])

const TOOL_FRAME_TYPES: ReadonlySet<string> = new Set([
  'tool-call',
  'tool-call-delta',
  'tool-use',
  'tool-use-delta',
  'tool-result',
  'function-call',
])

const PERMISSION_FRAME_TYPES: ReadonlySet<string> = new Set([
  'permission',
  'permission-request',
  'approval',
  'approval-request',
  'permission-denied',
])

/** Fields that may carry the assistant text of one frame, in fallback order. */
const TEXT_FIELDS: readonly string[] = ['text', 'delta', 'content', 'output_text', 'outputText', 'message', 'result']

/**
 * Fields that may carry a session id, in fallback order.
 *
 * `setting.json`'s `webRemoteControlLastEnabledContext.initialTaskId` is
 * deliberately absent: it holds a `sess_…` value on this host, but the user's
 * other ZCode conversations overwrite it, so it is a diagnostic fact, never a
 * session source.
 */
const SESSION_FIELDS: readonly string[] = ['sessionId', 'session_id', 'session', 'id']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Normalize a frame-type word: lowercase, `_` folded to `-`. */
function normalizeType(value: unknown): string | undefined {
  const raw = asString(value)
  return raw === undefined ? undefined : raw.trim().toLowerCase().replace(/_/g, '-')
}

/** Collect visible text out of a content-shaped value (string, block, or block array). */
function textOfContent(value: unknown): string | undefined {
  const direct = asString(value)
  if (direct !== undefined) return direct
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const entry of value) {
      const part = isRecord(entry) ? textOfContent(entry) : asString(entry)
      if (part !== undefined) parts.push(part)
    }
    const joined = parts.join('')
    return joined.length > 0 ? joined : undefined
  }
  if (isRecord(value)) {
    // One content block, e.g. `{type:'text', text:'…'}`; a non-text block
    // contributes nothing, which keeps a reasoning/tool block from being
    // mistaken for the answer.
    const type = normalizeType(value['type'])
    if (type !== undefined && type !== 'text' && type !== 'output-text') return undefined
    return textOfContent(value['text'])
  }
  return undefined
}

/** First non-empty text carried by one frame, in documented fallback order. */
export function frameText(node: Record<string, unknown>): string | undefined {
  for (const field of TEXT_FIELDS) {
    const found = textOfContent(node[field])
    if (found !== undefined && found.length > 0) return found
  }
  return undefined
}

/** First `sess_…`-shaped id carried by one frame, in documented fallback order. */
export function frameSessionId(node: Record<string, unknown>): string | undefined {
  for (const field of SESSION_FIELDS) {
    const candidate = asString(node[field])
    if (candidate !== undefined && candidate.startsWith(ZCODE_SESSION_ID_PREFIX)) return candidate
    const nested = isRecord(node[field]) ? asString(node[field]['id']) : undefined
    if (nested !== undefined && nested.startsWith(ZCODE_SESSION_ID_PREFIX)) return nested
  }
  return undefined
}

function firstNumber(node: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = asNumber(node[field])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Read token counters off one frame.
 *
 * Both naming conventions are accepted (`input_tokens` / `inputTokens`, and the
 * OpenAI-style `prompt_tokens` / `completion_tokens`): ZCode proxies several
 * upstream providers, and a counter that is silently dropped would show up as
 * zero usage in the DSH transcript.
 */
export function frameUsage(node: Record<string, unknown>): ZcodeTokenUsage | undefined {
  const container = isRecord(node['usage']) ? node['usage'] : node
  const inputTokens = firstNumber(container, ['inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens'])
  const outputTokens = firstNumber(container, ['outputTokens', 'output_tokens', 'completion_tokens', 'completionTokens'])
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const usage: {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  } = { inputTokens, outputTokens }
  const totalTokens = firstNumber(container, ['totalTokens', 'total_tokens'])
  if (totalTokens !== undefined) usage.totalTokens = totalTokens
  const cacheReadTokens = firstNumber(container, ['cacheReadTokens', 'cache_read_tokens', 'cached_tokens'])
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  const cacheWriteTokens = firstNumber(container, ['cacheWriteTokens', 'cache_write_tokens'])
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
  const reasoningTokens = firstNumber(container, ['reasoningTokens', 'reasoning_tokens'])
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  return usage
}

/**
 * Classify one already-parsed JSON value into normalized frames.
 *
 * A JSON *array* is treated as a batch of frames, which is the shape a
 * transcript dump would have; every other value is one frame.
 */
export function classifyJsonValue(value: unknown): ZcodeFrame[] {
  if (Array.isArray(value)) return value.flatMap(entry => classifyJsonValue(entry))
  if (!isRecord(value)) {
    const text = asString(value)
    return text === undefined ? [{ kind: 'unknown', raw: String(value) }] : [{ kind: 'text', text }]
  }

  const type = normalizeType(value['type'] ?? value['event'] ?? value['kind'])

  if (type !== undefined) {
    if (TOOL_FRAME_TYPES.has(type)) {
      return [{ kind: 'tool', request: 'tool-call', toolName: toolNameOf(value) }]
    }
    if (PERMISSION_FRAME_TYPES.has(type)) {
      return [{ kind: 'tool', request: 'permission', toolName: toolNameOf(value) }]
    }
    if (ERROR_FRAME_TYPES.has(type)) return [{ kind: 'error', error: errorOfFrame(value) }]
    if (SESSION_FRAME_TYPES.has(type)) {
      const sessionId = frameSessionId(value)
      const usage = frameUsage(value)
      const frames: ZcodeFrame[] = []
      if (sessionId !== undefined) frames.push({ kind: 'session', sessionId })
      if (usage !== undefined) frames.push({ kind: 'usage', usage })
      return frames.length > 0 ? frames : [{ kind: 'unknown', raw: JSON.stringify(value) }]
    }
    if (USAGE_FRAME_TYPES.has(type)) {
      const usage = frameUsage(value)
      return usage === undefined ? [{ kind: 'unknown', raw: JSON.stringify(value) }] : [{ kind: 'usage', usage }]
    }
    if (FINISH_FRAME_TYPES.has(type)) {
      const text = frameText(value)
      const frames: ZcodeFrame[] = []
      if (text !== undefined) frames.push({ kind: 'text', text })
      frames.push({ kind: 'finish', stopReason: finishReasonOf(value) })
      return frames
    }
    if (TEXT_FRAME_TYPES.has(type)) {
      const text = frameText(value)
      if (text !== undefined) {
        const frames: ZcodeFrame[] = [{ kind: 'text', text }]
        const usage = frameUsage(value)
        if (usage !== undefined) frames.push({ kind: 'usage', usage })
        return frames
      }
      // A text-shaped frame with no text is a recognized, empty event: it is
      // not "unknown" (shape is fine), but it also produced nothing to show.
      return []
    }
  }

  // No usable type word: fall back to field presence, most specific first.
  const sessionId = frameSessionId(value)
  if (sessionId !== undefined) return [{ kind: 'session', sessionId }]
  const usage = frameUsage(value)
  if (usage !== undefined) return [{ kind: 'usage', usage }]
  const rawError = value['error']
  if (rawError !== undefined && rawError !== null) return [{ kind: 'error', error: errorOfFrame(value) }]
  const text = frameText(value)
  if (text !== undefined) return [{ kind: 'text', text }]
  return [{ kind: 'unknown', raw: JSON.stringify(value) }]
}

function toolNameOf(node: Record<string, unknown>): string | undefined {
  const direct = asString(node['name']) ?? asString(node['toolName']) ?? asString(node['tool'])
  if (direct !== undefined) return direct
  const call = isRecord(node['toolCall']) ? node['toolCall'] : undefined
  return call === undefined ? undefined : asString(call['name'])
}

function finishReasonOf(node: Record<string, unknown>): string | undefined {
  return (
    asString(node['stopReason']) ?? asString(node['stop_reason']) ?? asString(node['reason']) ?? asString(node['status'])
  )
}

/**
 * Turn an in-band `error` frame into a classified ZcodeError.
 *
 * The JSON is handed to {@link classifyStderr} as text so that both channels
 * share one mapping table: an in-band provider code and a stderr provider code
 * must never disagree about what `1309` means.
 */
function errorOfFrame(node: Record<string, unknown>): ZcodeError {
  const message =
    asString(node['message']) ??
    (isRecord(node['error']) ? asString(node['error']['message']) : undefined) ??
    asString(node['error']) ??
    'ZCode reported an error frame on stdout'
  const classified = classifyStderr(`${message} ${JSON.stringify(node)}`)
  // Keep the frame's own message when classification found nothing distinctive.
  if (classified.code === 'ZCODE_UNKNOWN') {
    return new ZcodeError('ZCODE_UNKNOWN', message, {
      ...spreadTail(boundStderrTail(JSON.stringify(node))),
      cause: classified,
    })
  }
  return classified
}

/** Aggregate view of one complete stdout capture. */
export interface ZcodeParseResult {
  /** How the capture was understood; the caller only logs this. */
  readonly mode: 'ndjson' | 'single-json' | 'whole-json'
  /** Every recognized frame, in arrival order. */
  readonly frames: readonly ZcodeFrame[]
  /** Text deltas in arrival order (the assistant answer, piecewise). */
  readonly deltas: readonly string[]
  /** Concatenated deltas. */
  readonly text: string
  /** Session id observed on stdout, when ZCode printed one. */
  readonly sessionId: string | undefined
  /** Last usage frame, when ZCode reported counters. */
  readonly usage: ZcodeTokenUsage | undefined
  /** Provider stop reason, when reported. */
  readonly stopReason: string | undefined
  /** Tool-shaped frames; non-empty means the run must be failed closed. */
  readonly toolRequests: readonly ZcodeFrame[]
  /** In-band error frame, when the stream carried one. */
  readonly failure: ZcodeError | undefined
  /** Lines that were neither JSON nor recognizable. */
  readonly unknownLines: number
}

/**
 * Line-incremental parser.
 *
 * Feed raw stdout chunks with {@link pushChunk} (the process layer already
 * splits lines, so {@link pushLine} is the normal entry point) and collect the
 * frames of every complete line. A trailing line without a newline is held back
 * until {@link flush}, because half a JSON frame must never be classified.
 */
export class ZcodeStreamParser {
  private buffer = ''
  private textChars = 0
  private readonly seen: ZcodeFrame[] = []
  private rawHead = ''

  /** Bytes-worth of raw stdout retained for `ZCODE_PARSE` diagnostics. */
  get rawPreview(): string {
    return this.rawHead.length > PARSE_PREVIEW_MAX_CHARS
      ? this.rawHead.slice(0, PARSE_PREVIEW_MAX_CHARS)
      : this.rawHead
  }

  /** Total visible text characters parsed so far. */
  get textLength(): number {
    return this.textChars
  }

  /** Frames parsed so far, in arrival order (bounded by usage, not by caller reads). */
  get frames(): readonly ZcodeFrame[] {
    return this.seen
  }

  /** Feed one complete stdout line (no trailing newline). */
  pushLine(line: string): ZcodeFrame[] {
    const trimmed = line.trim()
    if (trimmed.length === 0) return []
    if (this.rawHead.length <= PARSE_PREVIEW_MAX_CHARS) {
      this.rawHead += `${line}\n`
    }
    const frames = this.classifyLine(trimmed)
    this.absorb(frames)
    return frames
  }

  /** Feed an arbitrary stdout chunk, emitting the frames of every complete line. */
  pushChunk(chunk: string): ZcodeFrame[] {
    this.buffer += chunk
    const frames: ZcodeFrame[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      frames.push(...this.pushLine(line))
      newline = this.buffer.indexOf('\n')
    }
    return frames
  }

  /** Flush a trailing line that never got its newline. */
  flush(): ZcodeFrame[] {
    if (this.buffer.length === 0) return []
    const rest = this.buffer
    this.buffer = ''
    return this.pushLine(rest)
  }

  private classifyLine(trimmed: string): ZcodeFrame[] {
    try {
      return classifyJsonValue(JSON.parse(trimmed))
    } catch {
      // Not JSON on this line: remember it as unknown, never as text. A
      // pretty-printed document fails every line and is recovered by
      // `parseStdout`'s whole-segment pass.
      return [{ kind: 'unknown', raw: trimmed }]
    }
  }

  private absorb(frames: readonly ZcodeFrame[]): void {
    for (const frame of frames) {
      this.seen.push(frame)
      if (frame.kind === 'text') this.textChars += frame.text.length
    }
  }
}

function summarize(frames: readonly ZcodeFrame[], mode: ZcodeParseResult['mode']): ZcodeParseResult {
  const deltas: string[] = []
  let sessionId: string | undefined
  let usage: ZcodeTokenUsage | undefined
  let stopReason: string | undefined
  let failure: ZcodeError | undefined
  const toolRequests: ZcodeFrame[] = []
  let unknownLines = 0

  for (const frame of frames) {
    switch (frame.kind) {
      case 'text':
        deltas.push(frame.text)
        break
      case 'session':
        sessionId = frame.sessionId
        break
      case 'usage':
        usage = frame.usage
        break
      case 'finish':
        if (frame.stopReason !== undefined) stopReason = frame.stopReason
        break
      case 'tool':
        toolRequests.push(frame)
        break
      case 'error':
        failure = frame.error
        break
      case 'unknown':
        unknownLines += 1
        break
    }
  }

  return {
    mode,
    frames,
    deltas,
    text: deltas.join(''),
    sessionId,
    usage,
    stopReason,
    toolRequests,
    failure,
    unknownLines,
  }
}

/**
 * Parse a complete stdout capture.
 *
 * Order of attempts: line-incremental (NDJSON), then whole-segment JSON, then
 * failure. Never returns an empty success: a capture with no text frame and no
 * error frame raises `ZCODE_PARSE` carrying the head of the raw output.
 *
 * @param stdout - the child's complete stdout.
 * @throws ZcodeError `ZCODE_PARSE` when no usable frame was found.
 */
export function parseStdout(stdout: string): ZcodeParseResult {
  const parser = new ZcodeStreamParser()
  const lineFrames = [...parser.pushChunk(stdout), ...parser.flush()]
  const jsonLines = lineFrames.filter(frame => frame.kind !== 'unknown').length
  const lineResult = summarize(lineFrames, jsonLines > 1 ? 'ndjson' : 'single-json')

  if (lineResult.deltas.length > 0 || lineResult.failure !== undefined) {
    return lineResult
  }

  // Nothing usable line-by-line: the capture may be one pretty-printed
  // document, which no individual line can parse.
  const trimmed = stdout.trim()
  if (trimmed.length > 0) {
    try {
      const frames = classifyJsonValue(JSON.parse(trimmed))
      const wholeResult = summarize(frames, 'whole-json')
      if (wholeResult.deltas.length > 0 || wholeResult.failure !== undefined) return wholeResult
    } catch {
      // Fall through to the fail-closed error below.
    }
  }

  const preview = parser.rawPreview
  throw new ZcodeError(
    'ZCODE_PARSE',
    preview.length > 0
      ? `ZCode produced no recognizable text frame on stdout; first ${preview.length} chars: ${preview}`
      : 'ZCode produced no output at all on stdout (the CLI prints failures on stderr only)',
    spreadTail(boundStderrTail(preview)),
  )
}

/**
 * Wrap an optional stderr tail so it can be spread into `ZcodeErrorOptions`.
 *
 * `exactOptionalPropertyTypes` forbids passing `undefined` for an optional
 * property, and the tail is legitimately absent when nothing was captured.
 */
function spreadTail(tail: string | undefined): { stderrTail?: string } {
  return tail === undefined ? {} : { stderrTail: tail }
}
