/**
 * Stable error surface of the ZCode provider.
 *
 * Everything downstream (adapter, stream framing, UI message, retry executor)
 * keys off `ZcodeError.code`, never off a message string: ZCode 0.17.0 writes
 * its failures to stderr as free-form Chinese text plus a bracketed provider
 * code, and only the code is stable across releases.
 *
 * This module is deliberately dependency-free and pure: it maps text to a
 * classified error, nothing else. It runs no process, reads no file, and never
 * touches `process.env`, so both the adapter and the offline tests can import it
 * without a ZCode installation present.
 */

/** Every code the provider can raise. Frozen: consumers switch on this union. */
export const ZCODE_ERROR_CODES = [
  /** Coding Plan / quota exhausted. ZCode 1309, or HTTP 429 carrying 1309. */
  'QUOTA',
  /** Throughput limit without a quota verdict. ZCode 3007, or HTTP 429 alone. */
  'RATE_LIMIT',
  /** The account or workspace is not permitted to run this model. ZCode 3012. */
  'PERMISSION_REQUIRED',
  /** Identity rejected: HTTP 401, or the standalone-account identity error. */
  'AUTH',
  /** The ZCode environment contract is incomplete; nothing was spawned. */
  'ZCODE_ENV_MISSING',
  /** ZCode does not know the requested model id. */
  'MODEL_NOT_FOUND',
  /** A stdout line was not the JSON frame the parser expected. */
  'ZCODE_PARSE',
  /** The child process ended without a machine-readable failure. */
  'ZCODE_EXIT',
  /** No rule matched, or a transport failure that is worth one retry. */
  'ZCODE_UNKNOWN',
  /** The wall-clock or inactivity watchdog killed the child. */
  'TIMEOUT',
  /** The caller aborted the request; the child was terminated. */
  'ABORTED',
  /** The configured tool policy cannot be honoured on this route. */
  'UNSUPPORTED_TOOLS',
  /** A request option this route cannot carry (temperature/maxTokens/stop) was set. */
  'UNSUPPORTED_OPTION',
  /** A request content block this route cannot carry (image/file under `reject`). */
  'UNSUPPORTED_CONTENT',
  /** The concurrency gate is full; nothing was spawned and no session was touched. */
  'ZCODE_BUSY',
  /** The child exceeded maxOutputBytes or maxEventLineLength; it was killed. */
  'ZCODE_OUTPUT_TOO_LARGE',
  /** The host could not resolve a workspace root for the session; nothing was spawned. */
  'WORKSPACE_UNAVAILABLE',
] as const

export type ZcodeErrorCode = typeof ZCODE_ERROR_CODES[number]

/** How much stderr text is retained on an error for diagnostics. */
export const STDERR_TAIL_MAX_CHARS = 2_048

/** Ceiling on `message` and `providerMessage`; third-party text never grows past this. */
export const DIAGNOSTIC_MAX_CHARS = 4_096

/**
 * Remove the credential-shaped substrings third-party text tends to carry.
 *
 * Light by design: three well-known shapes only (`Bearer …`, `token|key|sig=…`
 * query parameters, `sk-…` keys). Anything broader would start rewriting model
 * prose, which this provider has no business editing.
 */
export function sanitizeSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/([?&])(token|access_token|api_key|apikey|key|sig|signature)=[^&\s"'<>]+/gi, '$1$2=***')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '***')
}

/** Bound and sanitize one diagnostic string. */
export function boundDiagnostic(text: string): string
export function boundDiagnostic(text: string | undefined): string | undefined
export function boundDiagnostic(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const cleaned = sanitizeSecrets(text.trim())
  if (cleaned.length === 0) return undefined
  if (cleaned.length <= DIAGNOSTIC_MAX_CHARS) return cleaned
  return `…${cleaned.slice(cleaned.length - (DIAGNOSTIC_MAX_CHARS - 1))}`
}

/** Type guard for the frozen code list. */
export function isZcodeErrorCode(value: unknown): value is ZcodeErrorCode {
  return typeof value === 'string' && (ZCODE_ERROR_CODES as readonly string[]).includes(value)
}

/** Extra machine-readable facts attached to a classified failure. */
export interface ZcodeErrorOptions {
  /** Numeric provider code from the bracketed stderr prefix, e.g. 1309. */
  providerCode?: number
  /** Human message ZCode attached to the provider code. */
  providerMessage?: string
  /** HTTP status when the failure came from an HTTP response. */
  responseStatus?: number
  /** Per-request id from the third stderr bracket, e.g. `2026102401123552bbdbe6a99a4f3d`. */
  requestId?: string
  /** Trailing stderr text, bounded by {@link STDERR_TAIL_MAX_CHARS}. */
  stderrTail?: string
  /** Underlying error, if this one wraps another. */
  cause?: unknown
}

/**
 * The single error type of this provider.
 *
 * `code` is always one of {@link ZCODE_ERROR_CODES}; the diagnostic fields are
 * declared as `T | undefined` rather than optional so that
 * `exactOptionalPropertyTypes` consumers can read them without narrowing first.
 */
export class ZcodeError extends Error {
  readonly code: ZcodeErrorCode
  readonly providerCode: number | undefined
  readonly providerMessage: string | undefined
  readonly responseStatus: number | undefined
  readonly requestId: string | undefined
  readonly stderrTail: string | undefined

  constructor(code: ZcodeErrorCode, message: string, options: ZcodeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ZcodeError'
    this.code = code
    const boundedMessage = boundDiagnostic(message)
    if (boundedMessage !== undefined && boundedMessage !== message) this.message = boundedMessage
    this.providerCode = options.providerCode
    this.providerMessage = boundDiagnostic(options.providerMessage)
    this.responseStatus = options.responseStatus
    this.requestId = options.requestId
    this.stderrTail = boundStderrTail(options.stderrTail)
  }
}

/** Type guard for a value raised by this provider. */
export function isZcodeError(value: unknown): value is ZcodeError {
  return value instanceof ZcodeError
}

/**
 * Bound and normalize a stderr capture for attachment to an error.
 *
 * The returned string is never longer than {@link STDERR_TAIL_MAX_CHARS}: the
 * ellipsis that marks the cut counts against the budget, so a caller can size a
 * log field from the constant alone.
 */
export function boundStderrTail(stderr: string | undefined): string | undefined {
  if (stderr === undefined) return undefined
  const trimmed = sanitizeSecrets(stderr.trim())
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= STDERR_TAIL_MAX_CHARS) return trimmed
  return `…${trimmed.slice(trimmed.length - (STDERR_TAIL_MAX_CHARS - 1))}`
}

/**
 * ZCode's structured stderr prefix:
 * `ProviderBusinessError: [1309][您的GLM Coding Plan套餐已到期…][2026102401123552bbdbe6a99a4f3d]`
 *
 * Group 1 is the numeric provider code, 2 the human message, 3 the request id.
 * The message group cannot contain `]`, which is exactly the guarantee ZCode's
 * own bracket pairing provides.
 */
const PROVIDER_PREFIX = /\[(\d{4})\]\[([^\]]+)\]\[([^\]]+)\]/

/** `--verbose` prints the underlying transport failure on a `Cause:` line. */
const VERBOSE_CAUSE = /^\s*Cause:\s*(.+)$/m

/**
 * HTTP status as printed by the CLI or the embedded client.
 *
 * Three shapes are real: `HTTP 429`, `status: 429` / `status code: 429`, and the
 * object field a `PROVIDER_BUSINESS_ERROR` dump carries, `responseStatus: 429`
 * (or `responseStatus=429`). The keyword deliberately has no `\b` in front of
 * `status`: in the dump the word is glued to `response`, so `\bstatus` never
 * holds there and the real 429 used to be dropped.
 *
 * Strictness is unchanged: the separator budget holds punctuation and spaces
 * only (never letters), so this cannot drift into "any number near the word
 * status", and the payload stays exactly three digits with a trailing word
 * boundary (`4290` is not a status).
 */
const HTTP_STATUS = /\b(?:HTTP|(?:response)?status(?:[\s_-]*code)?)[\s:=,-]{0,4}(\d{3})\b/i

const QUIET_KEY = 1309
const RATE_LIMIT_KEY = 3007
const PERMISSION_KEY = 3012

const AUTH_MESSAGE = /请求身份无效|身份无效|unauthori[sz]ed|invalid[\s_-]*(?:api[\s_-]*)?(?:key|token|credential)|authentication/i
const ENV_MESSAGE = /无法定位\s*CLI ZCode Built-in Provider Config|必须同时提供|Cannot find module|node:sqlite/i
const MODEL_MESSAGE = /unknown model|model\b[^\n]{0,40}\bnot (?:found|exist)|(?:模型|model)[^\n]{0,20}(?:不存在|无效|不支持)|invalid model/i
const TRANSPORT_MESSAGE = /Cannot connect to API|AggregateError|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed/i
const QUOTA_MESSAGE = /套餐已到期|套餐已用完|额度(?:已)?(?:用尽|耗尽)|quota|insufficient[_ ]?(?:balance|quota)|plan (?:has )?expired/i
const RATE_MESSAGE = /rate[\s_-]*limit|too many requests|请求过于频繁|限流/i
const PERMISSION_MESSAGE = /permission|not permitted|无权限|权限不足|forbidden|403/i

/** Inputs to {@link classifyStderr} beyond the stderr text itself. */
export interface ClassifyOptions {
  /** Child exit code; `null` when the process was killed by a signal. */
  exitCode?: number | null
  /** Exit signal, when the child was terminated rather than exited. */
  signal?: string | null
  /** Set when `--verbose` was used, enabling the `Cause:` fallback. */
  verbose?: boolean
}

/**
 * Map a finished ZCode process to a {@link ZcodeError}.
 *
 * Resolution order is most-specific first, because a single stderr capture can
 * satisfy several rules (a 429 that also says "quota" must classify as QUOTA):
 *
 * 1. the bracketed provider code (1309 / 3007 / 3012);
 * 2. an HTTP status (401 / 429 / 403);
 * 3. a distinctive message (env contract, auth identity, unknown model);
 * 4. a transport failure — retryable, so `ZCODE_UNKNOWN`;
 * 5. the exit code alone — `ZCODE_EXIT`.
 *
 * `ZCODE_PARSE`, `TIMEOUT` and `ABORTED` are never produced here: the parser and
 * the process supervisor raise those directly.
 */
export function classifyStderr(stderr: string, options: ClassifyOptions = {}): ZcodeError {
  const text = stderr ?? ''
  const tail = boundStderrTail(text)
  const prefix = PROVIDER_PREFIX.exec(text)
  const providerCode = prefix?.[1] === undefined ? undefined : Number(prefix[1])
  const providerMessage = prefix?.[2]
  const requestId = prefix?.[3]
  const cause = options.verbose === true ? VERBOSE_CAUSE.exec(text)?.[1]?.trim() : undefined
  const status = readHttpStatus(text)

  const shared: ZcodeErrorOptions = {
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(providerMessage === undefined ? {} : { providerMessage }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(status === undefined ? {} : { responseStatus: status }),
    ...(tail === undefined ? {} : { stderrTail: tail }),
  }

  if (providerCode === QUIET_KEY || QUOTA_MESSAGE.test(text)) {
    return new ZcodeError('QUOTA', describe('ZCode quota is exhausted', providerCode, providerMessage, cause), shared)
  }
  if (providerCode === RATE_LIMIT_KEY || RATE_MESSAGE.test(text)) {
    return new ZcodeError('RATE_LIMIT', describe('ZCode rate limit reached', providerCode, providerMessage, cause), shared)
  }
  if (providerCode === PERMISSION_KEY || status === 403 || PERMISSION_MESSAGE.test(text)) {
    return new ZcodeError('PERMISSION_REQUIRED', describe('ZCode refused the request for this account', providerCode, providerMessage, cause), shared)
  }
  if (status === 401 || AUTH_MESSAGE.test(text)) {
    return new ZcodeError('AUTH', describe('ZCode rejected the request identity', providerCode, providerMessage, cause), shared)
  }
  if (ENV_MESSAGE.test(text)) {
    return new ZcodeError('ZCODE_ENV_MISSING', describe('ZCode environment contract is incomplete', providerCode, providerMessage, cause), shared)
  }
  if (MODEL_MESSAGE.test(text)) {
    return new ZcodeError('MODEL_NOT_FOUND', describe('ZCode does not know the requested model', providerCode, providerMessage, cause), shared)
  }
  if (status === 429) {
    return new ZcodeError('RATE_LIMIT', describe('ZCode rate limit reached', providerCode, providerMessage, cause), shared)
  }
  if (TRANSPORT_MESSAGE.test(text)) {
    return new ZcodeError(
      'ZCODE_UNKNOWN',
      describe('ZCode could not reach its API (check NODE_OPTIONS ipv4first)', providerCode, providerMessage, cause),
      shared,
    )
  }
  return new ZcodeError('ZCODE_EXIT', exitMessage(options.exitCode, options.signal, providerMessage, cause), shared)
}

function readHttpStatus(text: string): number | undefined {
  const match = HTTP_STATUS.exec(text)
  if (match?.[1] === undefined) return undefined
  const status = Number(match[1])
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

function describe(headline: string, providerCode: number | undefined, providerMessage: string | undefined, cause: string | undefined): string {
  const parts = [headline]
  if (providerCode !== undefined) parts.push(`[${providerCode}]`)
  if (providerMessage !== undefined) parts.push(providerMessage)
  if (cause !== undefined) parts.push(`(${cause})`)
  return parts.join(' ')
}

function exitMessage(exitCode: number | null | undefined, signal: string | null | undefined, providerMessage: string | undefined, cause: string | undefined): string {
  const how = signal !== null && signal !== undefined && signal !== ''
    ? `was killed by ${signal}`
    : `exited with code ${exitCode === null || exitCode === undefined ? 'unknown' : String(exitCode)}`
  return describe(`ZCode ${how} without a machine-readable error`, undefined, providerMessage, cause)
}
