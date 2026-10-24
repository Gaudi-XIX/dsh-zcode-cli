/**
 * The HTTP transport of the ZCode provider: the Anthropic Messages endpoint
 * that both the free (`zcode-plan`) and the paid channel speak.
 *
 * Why this module exists at all: the CLI channel spawns
 * `resources/glm/zcode.cjs` and pays a process per turn, and it cannot be
 * reached at all without the CLI's own login state. The two HTTP channels are
 * the same endpoint the CLI itself calls, so a turn costs one request instead
 * of one process — but they carry two different identities:
 *
 * - `free` authenticates with the **encrypted** `zcodejwttoken` the ZCode CLI
 *   stores (`<dataBaseDir>/.zcode/v2/credentials.json`), which is device-bound
 *   via `x-device-mid` from `telemetry-state.json`. Both are read through
 *   {@link resolveZcodeCredential}, never decrypted here.
 * - `paid` authenticates with a plain API key from the environment. It has no
 *   device id and no session binding, so no `metadata.user_id` is sent.
 *
 * What is deliberately *not* here: no retry loop (the DSH retry executor owns
 * that, driven by {@link ZcodeError.code}), no session store, no tool
 * execution. This module turns one request into one stream of events and
 * classifies every failure into a `ZcodeError`.
 *
 * The request body is a byte-level mirror of the captured ZCode 0.17.0 turn
 * (`F:\AgentData\.agents\flow\tmp\zc-capture.json`, 2026-10-24): the same
 * `system` prefix blocks with their cache markers, the same
 * `metadata.user_id`, `thinking: {type: 'enabled'}`, `output_config.effort`
 * and `stream: true`. The free channel accepted exactly that body live, so any
 * deviation is a request nothing here can validate.
 */

import { release } from 'node:os'

import { ZcodeError, sanitizeSecrets, type ZcodeErrorCode } from '../provider/error-codes.js'
import {
  DEFAULT_EFFORT,
  DEFAULT_PAID_BASE_URL,
  ZCODE_PAID_API_KEY_ENV,
  ZCODE_DATA_BASE_DIR_ENV,
  type ZcodeCredentialChannel,
  type ZcodeEffort,
} from '../provider/config.js'
import { resolveZcodeCredential } from './billing.js'
import { ZCODE_SYSTEM_PREFIX_BLOCKS } from './prefix.js'

/** The free (`Coding Plan`) deployment of the Messages endpoint, as captured. */
export const ZCODE_FREE_BASE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic'

/** Path both deployments append to their base URL. */
export const ZCODE_MESSAGES_PATH = '/v1/messages'

/** Ceiling on the error-body excerpt attached to a classified failure. */
export const ZCODE_HTTP_BODY_SNIPPET_MAX_CHARS = 512

/** `max_tokens` used when the caller does not set one; the capture used 128000. */
export const ZCODE_HTTP_DEFAULT_MAX_TOKENS = 128_000

/** Request ceiling when the caller passes no `timeoutMs`. */
export const ZCODE_HTTP_DEFAULT_TIMEOUT_MS = 900_000

/** The Anthropic protocol version both deployments accept. */
export const ZCODE_ANTHROPIC_VERSION = '2023-06-01'

/** One turn of conversation, already flattened to text by the adapter. */
export interface ZcodeHttpMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** Token counts as the endpoint reports them. */
export interface ZcodeHttpUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** One thing the adapter can act on while the answer streams in. */
export type ZcodeHttpEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: ZcodeHttpUsage }
  | { readonly type: 'stop'; readonly reason: string | undefined }

/** Everything one HTTP turn needs. */
export interface ZcodeHttpRequest {
  readonly channel: ZcodeCredentialChannel
  readonly model: string
  /** Placement of `output_config.effort`; defaults to {@link DEFAULT_EFFORT}. */
  readonly effort?: ZcodeEffort
  readonly messages: readonly ZcodeHttpMessage[]
  /** Caller system prompts, appended after the captured prefix blocks. */
  readonly system?: readonly string[]
  readonly maxTokens?: number
  /** Sampling temperature; omitted from the body when unset (the capture sent none). */
  readonly temperature?: number
  /** Stop sequences; omitted from the body when empty. */
  readonly stop?: readonly string[]
  /** Durable ZCode session id; goes into `metadata.user_id` on the free channel. */
  readonly sessionId?: string
  /** Paid channel only: API key. Never read from a config file. */
  readonly apiKey?: string
  /** Paid channel only: base URL override. */
  readonly baseUrl?: string
  /** Environment the credential store and the paid key are resolved from. */
  readonly env?: Record<string, string | undefined>
  /** ZCode *data* root (`<root>/.zcode/v2/...`); defaults to `ZCODE_DATA_BASE_DIR`. */
  readonly dataBaseDir?: string
  readonly timeoutMs?: number
  /** Caller cancellation; linked into the request's own controller. */
  readonly signal?: AbortSignal
  /** Injected for tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/** What one channel needs to authenticate one request. */
export interface ZcodeHttpAuth {
  readonly channel: ZcodeCredentialChannel
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** Free channel only: the device id that `metadata.user_id` repeats. */
  readonly deviceMid: string | undefined
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The platform facts the captured request carried as headers. */
function platformHeaders(): Record<string, string> {
  const platform = `${process.platform}-${process.arch}`
  const osCategory = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  return {
    'x-platform': platform,
    'x-os-category': osCategory,
    'x-os-version': release(),
  }
}

/**
 * Join a base URL and {@link ZCODE_MESSAGES_PATH} without doubling the path.
 *
 * The paid deployments are published both as an origin
 * (`https://open.bigmodel.cn`) and as an origin plus prefix
 * (`…/api/anthropic`), so the composition has to tolerate either.
 */
export function resolveZcodeHttpEndpoint(channel: ZcodeCredentialChannel, baseUrl?: string): string {
  const fallback = channel === 'free' ? ZCODE_FREE_BASE_URL : DEFAULT_PAID_BASE_URL
  const base = nonEmpty(baseUrl) ?? fallback
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  return trimmed.endsWith(ZCODE_MESSAGES_PATH) ? trimmed : `${trimmed}${ZCODE_MESSAGES_PATH}`
}

/**
 * Resolve the identity for one request.
 *
 * Fails closed on both channels before any socket is opened: a missing
 * credential store (`ZCODE_CREDENTIAL_MISSING`) and a missing paid key
 * (`ZCODE_ENV_MISSING`) are local, fixable conditions, and sending the request
 * anyway would only trade them for a 401 that says less.
 */
export async function resolveZcodeHttpAuth(request: ZcodeHttpRequest): Promise<ZcodeHttpAuth> {
  const env = request.env ?? process.env
  const url = resolveZcodeHttpEndpoint(request.channel, request.baseUrl)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // The capture sent `*/*` and still received SSE; keep it byte-identical
    // rather than advertising a parser the endpoint may or may not branch on.
    accept: '*/*',
    'accept-language': '*',
    'accept-encoding': 'identity',
    'anthropic-version': ZCODE_ANTHROPIC_VERSION,
    'http-referer': 'https://zcode.z.ai',
    'x-client-language': nonEmpty(env['LANG']) ?? 'en-US',
    'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    'x-release-channel': 'production',
    'x-title': 'Z Code@cli',
    'x-zcode-app-version': '0.17.0',
    'sec-fetch-mode': 'cors',
    ...platformHeaders(),
  }

  if (request.channel === 'paid') {
    const apiKey = nonEmpty(request.apiKey) ?? nonEmpty(env[ZCODE_PAID_API_KEY_ENV])
    if (apiKey === undefined) {
      throw new ZcodeError(
        'ZCODE_ENV_MISSING',
        `channel=paid needs an API key: set ${ZCODE_PAID_API_KEY_ENV} in the host environment`,
      )
    }
    headers['x-api-key'] = apiKey
    headers['authorization'] = `Bearer ${apiKey}`
    return { channel: 'paid', url, headers, deviceMid: undefined }
  }

  const dataBaseDir = nonEmpty(request.dataBaseDir) ?? nonEmpty(env[ZCODE_DATA_BASE_DIR_ENV])
  if (dataBaseDir === undefined) {
    throw new ZcodeError(
      'ZCODE_ENV_MISSING',
      `channel=${request.channel} needs the ZCode data root: set ${ZCODE_DATA_BASE_DIR_ENV}`,
    )
  }
  const { jwt, deviceMid } = await resolveZcodeCredential(dataBaseDir, env)
  headers['authorization'] = `Bearer ${jwt}`
  headers['x-device-mid'] = deviceMid
  headers['x-api-key'] = jwt
  return { channel: request.channel, url, headers, deviceMid }
}

/**
 * Merge adjacent same-role messages.
 *
 * The Anthropic Messages shape alternates roles; DSH hands over a history
 * where two user turns can sit back to back (tool results, injected reminders).
 * Merging keeps the request valid without dropping a turn, and it is
 * idempotent so a caller that already merged loses nothing.
 */
export function mergeHttpMessages(messages: readonly ZcodeHttpMessage[]): readonly ZcodeHttpMessage[] {
  const merged: ZcodeHttpMessage[] = []
  for (const message of messages) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.role === message.role) {
      merged[merged.length - 1] = { role: previous.role, content: `${previous.content}\n\n${message.content}` }
      continue
    }
    merged.push({ role: message.role, content: message.content })
  }
  return merged
}

/** The `system` array: captured prefix blocks first, caller text after them. */
export function buildSystemBlocks(system: readonly string[] | undefined): readonly Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = ZCODE_SYSTEM_PREFIX_BLOCKS.map(block =>
    block.cacheControl === undefined
      ? { type: 'text', text: block.text }
      : { type: 'text', text: block.text, cache_control: { type: block.cacheControl.type } },
  )
  for (const entry of system ?? []) {
    const text = entry.trim()
    if (text.length > 0) blocks.push({ type: 'text', text })
  }
  return blocks
}

/** Build the exact JSON body one turn sends. Exported for the shape test. */
export function buildZcodeHttpBody(request: ZcodeHttpRequest, auth: ZcodeHttpAuth): Record<string, unknown> {
  const messages = mergeHttpMessages(request.messages).map(message => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }))
  if (messages.length === 0) {
    throw new ZcodeError('UNSUPPORTED_CONTENT', 'channel=http needs at least one message; the request would be empty')
  }
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? ZCODE_HTTP_DEFAULT_MAX_TOKENS,
    system: buildSystemBlocks(request.system),
    messages,
    thinking: { type: 'enabled' },
    output_config: { effort: request.effort ?? DEFAULT_EFFORT },
    stream: true,
  }
  // Optional sampling fields. They are sent only when the caller set them: the
  // captured request carried neither, and defaulting a stop sequence or a
  // temperature would change a turn the caller described precisely.
  if (request.temperature !== undefined) body['temperature'] = request.temperature
  if (request.stop !== undefined && request.stop.length > 0) body['stop_sequences'] = [...request.stop]
  // The capture binds the free channel to one device and one CLI session.
  // The paid channel has neither, and sending an empty device id there would be
  // a claim this adapter cannot back.
  if (auth.channel !== 'paid') {
    body['metadata'] = {
      user_id: JSON.stringify({
        device_id: auth.deviceMid ?? '',
        account_uuid: '',
        session_id: request.sessionId ?? '',
      }),
    }
  }
  return body
}

/** Pull the first provider code out of an error body, if it carries one. */
export function extractProviderCode(body: string): number | undefined {
  const patterns = [/"providerCode"\s*:\s*"?(\d{3,5})/, /"code"\s*:\s*"?(\d{3,5})/, /\[(\d{3,5})[\]\s]/, /\b(1309|3001|3007|3012)\b/]
  for (const pattern of patterns) {
    const match = pattern.exec(body)
    if (match?.[1] !== undefined) {
      const value = Number.parseInt(match[1], 10)
      if (Number.isFinite(value)) return value
    }
  }
  return undefined
}

function bodySnippet(body: string): string | undefined {
  const cleaned = sanitizeSecrets(body.trim())
  if (cleaned.length === 0) return undefined
  return cleaned.length <= ZCODE_HTTP_BODY_SNIPPET_MAX_CHARS
    ? cleaned
    : `${cleaned.slice(0, ZCODE_HTTP_BODY_SNIPPET_MAX_CHARS - 1)}…`
}

/**
 * Classify one non-2xx response (or one in-stream `error` payload).
 *
 * Order matters: 1309 is a quota verdict that arrives as HTTP 429, so the
 * provider code is read before the status. A 5xx is a transport failure the
 * DSH retry executor may spend another attempt on (`ZCODE_UNKNOWN`); an
 * unclassified 4xx is the request's own shape and is not retried (`ZCODE_HTTP`).
 */
export function classifyZcodeHttpFailure(status: number, body: string): ZcodeError {
  const providerCode = extractProviderCode(body)
  const snippet = bodySnippet(body)
  const options: { providerCode?: number; providerMessage?: string; responseStatus?: number } = {
    responseStatus: status,
  }
  if (providerCode !== undefined) options.providerCode = providerCode
  if (snippet !== undefined) options.providerMessage = snippet

  if (providerCode === 1309) {
    return new ZcodeError('QUOTA', 'The Coding Plan has no quota left (provider code 1309)', options)
  }
  if (providerCode === 3012 || /signature|risk[- ]control|unusual activity/i.test(body)) {
    return new ZcodeError(
      'PERMISSION_REQUIRED',
      'The account is not permitted to run this model (provider code 3012 or a risk-control rejection)',
      options,
    )
  }
  if (providerCode === 3007) {
    return new ZcodeError('RATE_LIMIT', 'The endpoint is at its throughput limit (provider code 3007)', options)
  }
  if (providerCode === 3001) {
    return new ZcodeError(
      'ZCODE_HTTP',
      'The Messages endpoint rejected the request shape (provider code 3001); the device id or session binding is likely missing',
      options,
    )
  }
  if (status === 401 || status === 403) {
    return new ZcodeError(
      'AUTH',
      status === 401
        ? 'The Messages endpoint rejected the identity (HTTP 401); sign in again or set a valid API key'
        : 'The Messages endpoint refused this account (HTTP 403)',
      options,
    )
  }
  if (status === 404) {
    return new ZcodeError('MODEL_NOT_FOUND', `The Messages endpoint has no route or model for this request (HTTP 404)`, options)
  }
  if (status === 429) {
    return new ZcodeError('RATE_LIMIT', 'The Messages endpoint rate-limited the request (HTTP 429)', options)
  }
  if (status >= 500) {
    return new ZcodeError(
      'ZCODE_UNKNOWN',
      `The Messages endpoint answered HTTP ${status}; the upstream failed before or during the turn`,
      options,
    )
  }
  return new ZcodeError(
    'ZCODE_HTTP',
    `The Messages endpoint answered HTTP ${status}; the request shape or the channel binding is wrong`,
    options,
  )
}

/** Read at most `limit` characters of a response body, then stop pulling. */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return await response.text().catch(() => '')
  const decoder = new TextDecoder()
  let out = ''
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
      if (out.length >= limit) break
    }
  } catch {
    // A body that dies mid-read still leaves whatever arrived usable.
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return out
}

/** One SSE event after the wire format has been stripped. */
export interface ZcodeSseEvent {
  readonly event: string | undefined
  readonly data: string
}

/**
 * Turn a byte stream of `text/event-stream` into events.
 *
 * Deliberately small: this parser only knows the two-line grammar
 * (`event:` / `data:` terminated by a blank line) and comments. Anything it
 * cannot parse is a `ZCODE_PARSE` failure, because a silently skipped frame is
 * a silently truncated answer.
 */
export async function* parseZcodeSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ZcodeSseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      for (;;) {
        const match = /\r?\n/.exec(buffer)
        if (match === null) break
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (line.length === 0) {
          if (data.length > 0) yield { event, data: data.join('\n') }
          event = undefined
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const rawValue = colon === -1 ? '' : line.slice(colon + 1)
        const value2 = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
        if (field === 'event') event = value2
        else if (field === 'data') data.push(value2)
      }
      if (done) break
    }
    // A final frame without a trailing blank line is still a frame.
    if (data.length > 0) yield { event, data: data.join('\n') }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function usageOf(raw: unknown, previous: ZcodeHttpUsage | undefined): ZcodeHttpUsage | undefined {
  const usage = asRecord(raw)
  if (usage === undefined) return previous
  const inputTokens = numberOf(usage['input_tokens']) || previous?.inputTokens || 0
  const outputTokens = numberOf(usage['output_tokens']) || previous?.outputTokens || 0
  const cacheReadTokens = numberOf(usage['cache_read_input_tokens']) || previous?.cacheReadTokens || 0
  const cacheWriteTokens = numberOf(usage['cache_creation_input_tokens']) || previous?.cacheWriteTokens || 0
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return previous
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/** Content blocks of a non-streaming (JSON) answer, in the same shape. */
function* jsonAnswerEvents(payload: Record<string, unknown>): Generator<ZcodeHttpEvent> {
  const blocks = Array.isArray(payload['content']) ? payload['content'] : []
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (block === undefined) continue
    const text = block['text']
    if (typeof text !== 'string' || text.length === 0) continue
    yield block['type'] === 'thinking' ? { type: 'thinking', text } : { type: 'text', text }
  }
  const usage = usageOf(payload['usage'], undefined)
  if (usage !== undefined) yield { type: 'usage', usage }
  const stop = payload['stop_reason']
  yield { type: 'stop', reason: typeof stop === 'string' ? stop : undefined }
}

/**
 * Map one SSE `data` payload to zero or more events.
 *
 * Exported so the test can drive the mapping table without a socket. An
 * in-stream `error` object is classified exactly like a non-2xx response,
 * because the endpoint reports mid-turn failures that way with HTTP 200.
 */
export function mapZcodeSsePayload(
  payload: Record<string, unknown>,
  state: { usage: ZcodeHttpUsage | undefined; sawStop: boolean },
): ZcodeHttpEvent[] {
  const type = typeof payload['type'] === 'string' ? payload['type'] : undefined
  switch (type) {
    case 'error': {
      const error = asRecord(payload['error']) ?? {}
      const code = numberOf(error['code'])
      const message = typeof error['message'] === 'string' ? error['message'] : 'The stream reported an error'
      // HTTP 200 on purpose: the status is already spent, so only the provider
      // code and the message text may decide how this failure is classified.
      throw classifyZcodeHttpFailure(200, JSON.stringify({ providerCode: code, message }))
    }
    case 'message_start': {
      const usage = usageOf(asRecord(payload['message'])?.['usage'], state.usage)
      if (usage === undefined) return []
      state.usage = usage
      return [{ type: 'usage', usage }]
    }
    case 'content_block_start': {
      const block = asRecord(payload['content_block'])
      const text = typeof block?.['text'] === 'string' ? (block['text'] as string) : ''
      if (text.length === 0) return []
      return block?.['type'] === 'thinking' ? [{ type: 'thinking', text }] : [{ type: 'text', text }]
    }
    case 'content_block_delta': {
      const delta = asRecord(payload['delta'])
      if (delta === undefined) return []
      const text = typeof delta['text'] === 'string' ? delta['text'] : ''
      const thinking = typeof delta['thinking'] === 'string' ? delta['thinking'] : ''
      const out: ZcodeHttpEvent[] = []
      if (thinking.length > 0) out.push({ type: 'thinking', text: thinking })
      if (text.length > 0) out.push({ type: 'text', text })
      return out
    }
    case 'message_delta': {
      const out: ZcodeHttpEvent[] = []
      const usage = usageOf(payload['usage'], state.usage)
      if (usage !== undefined && usage !== state.usage) {
        state.usage = usage
        out.push({ type: 'usage', usage })
      }
      const delta = asRecord(payload['delta'])
      const stop = delta?.['stop_reason']
      if (typeof stop === 'string') {
        state.sawStop = true
        out.push({ type: 'stop', reason: stop })
      }
      return out
    }
    case 'message_stop': {
      state.sawStop = true
      return [{ type: 'stop', reason: state.usage === undefined ? undefined : 'end_turn' }]
    }
    default:
      // `ping`, `content_block_stop`, and any future frame this adapter has no
      // behaviour for. Ignoring is safe because termination is checked below.
      return []
  }
}

/**
 * One HTTP turn, streamed.
 *
 * Yields text, thinking, usage and stop events; throws `ZcodeError` on any
 * failure. The caller owns the mapping to DSH's stream types — this module
 * knows nothing about them on purpose.
 */
export async function* streamZcodeHttp(request: ZcodeHttpRequest): AsyncGenerator<ZcodeHttpEvent> {
  const auth = await resolveZcodeHttpAuth(request)
  const body = buildZcodeHttpBody(request, auth)
  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = request.timeoutMs ?? ZCODE_HTTP_DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  request.signal?.addEventListener('abort', onAbort, { once: true })
  const fetchImpl = request.fetchImpl ?? fetch
  let terminal = false
  try {
    let response: Response
    try {
      response = await fetchImpl(auth.url, {
        method: 'POST',
        headers: auth.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) {
        throw new ZcodeError('TIMEOUT', `channel=${request.channel} made no complete request within ${timeoutMs} ms`, {
          cause: error,
        })
      }
      if (controller.signal.aborted) {
        throw new ZcodeError('ABORTED', `channel=${request.channel} request was aborted by the caller`, { cause: error })
      }
      throw new ZcodeError(
        'ZCODE_UNKNOWN',
        `channel=${request.channel} could not reach ${auth.url}: ${describe(error)}`,
        { cause: error },
      )
    }

    if (!response.ok) {
      const text = await readBoundedBody(response, ZCODE_HTTP_BODY_SNIPPET_MAX_CHARS * 4)
      throw classifyZcodeHttpFailure(response.status, text)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const text = await response.text()
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch (error) {
        throw new ZcodeError('ZCODE_PARSE', 'The Messages endpoint answered JSON that does not parse', { cause: error })
      }
      const record = asRecord(payload)
      if (record === undefined) {
        throw new ZcodeError('ZCODE_PARSE', 'The Messages endpoint answered JSON that is not an object')
      }
      if (typeof record['type'] === 'string' && record['type'] === 'error') {
        const events = mapZcodeSsePayload(record, { usage: undefined, sawStop: false })
        yield* events
        return
      }
      for (const event of jsonAnswerEvents(record)) {
        if (event.type === 'stop') terminal = true
        yield event
      }
      return
    }

    if (response.body === null) {
      throw new ZcodeError('ZCODE_PARSE', 'The Messages endpoint answered without a body')
    }

    const state: { usage: ZcodeHttpUsage | undefined; sawStop: boolean } = { usage: undefined, sawStop: false }
    for await (const frame of parseZcodeSse(response.body)) {
      if (frame.data === '[DONE]') {
        state.sawStop = true
        break
      }
      let payload: unknown
      try {
        payload = JSON.parse(frame.data)
      } catch (error) {
        throw new ZcodeError(
          'ZCODE_PARSE',
          `The stream carried a data frame that is not JSON (event=${frame.event ?? 'none'})`,
          { cause: error },
        )
      }
      const record = asRecord(payload)
      if (record === undefined) continue
      for (const event of mapZcodeSsePayload(record, state)) {
        if (event.type === 'stop') terminal = true
        yield event
      }
    }

    // A stream that stops before the endpoint says it is done is a truncated
    // answer, not an empty one: surfacing it keeps the user from reading half a
    // sentence as the whole reply.
    if (!state.sawStop && !terminal) {
      throw new ZcodeError(
        'ZCODE_PARSE',
        'The answer stream ended without message_stop; the reply is truncated',
      )
    }
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}

/** Codes this module can raise; kept next to the classifier for the docs test. */
export const ZCODE_HTTP_ERROR_CODES: readonly ZcodeErrorCode[] = [
  'QUOTA',
  'RATE_LIMIT',
  'PERMISSION_REQUIRED',
  'AUTH',
  'MODEL_NOT_FOUND',
  'ZCODE_ENV_MISSING',
  'ZCODE_CREDENTIAL_MISSING',
  'ZCODE_CREDENTIAL_INVALID',
  'ZCODE_CREDENTIAL_DECRYPT_FAILED',
  'ZCODE_HTTP',
  'ZCODE_PARSE',
  'ZCODE_UNKNOWN',
  'TIMEOUT',
  'ABORTED',
  'UNSUPPORTED_CONTENT',
]
