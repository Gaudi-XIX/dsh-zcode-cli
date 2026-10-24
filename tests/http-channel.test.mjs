/**
 * Offline contract tests for the HTTP transport.
 *
 * The rule for this file mirrors `tests/billing.test.mjs`: no real credential
 * store and no real network. Every `fetch` is a mock that records what it was
 * handed, and the credential store is written here with a fixed secret and a
 * fixed IV.
 *
 * What these tests defend, in order of how expensive the bug would be:
 * 1. the request body stays a byte-level mirror of the captured ZCode turn —
 *    the free channel accepted exactly that body live, so a drifting field is a
 *    request nothing else in this project can validate;
 * 2. a failure is classified into the one `ZcodeError` code the DSH retry
 *    executor and the panel both key on;
 * 3. a truncated stream never reads as a complete answer.
 */

import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'

import { ZcodeError } from '../lib/provider/error-codes.js'
import { ZcodeAdapter, toHttpMessages } from '../lib/provider/zcode.js'
import { DEFAULT_PAID_BASE_URL, ZCODE_PAID_API_KEY_ENV } from '../lib/provider/config.js'
import {
  ZCODE_ANTHROPIC_VERSION,
  ZCODE_FREE_BASE_URL,
  ZCODE_HTTP_DEFAULT_MAX_TOKENS,
  buildZcodeHttpBody,
  classifyZcodeHttpFailure,
  extractProviderCode,
  mapZcodeSsePayload,
  mergeHttpMessages,
  resolveZcodeHttpAuth,
  resolveZcodeHttpEndpoint,
  streamZcodeHttp,
} from '../lib/zcode/http-channel.js'
import { deriveCredentialSecret } from '../lib/zcode/billing.js'
import { ZCODE_SYSTEM_PREFIX_BLOCKS, ZCODE_SYSTEM_PREFIX_CHARS } from '../lib/zcode/prefix.js'

const TEST_SECRET = 'http-channel-test-secret'
const TEST_JWT = 'jwt-header.payload.signature'
const TEST_DEVICE = 'device-mid-from-telemetry'

function encryptValue(value, secret) {
  // Mirror the store format exactly: 12-byte IV and 16-byte GCM tag
  // (`GCM_IV_BYTES` / `GCM_TAG_BYTES` in src/zcode/billing.ts), key =
  // sha256(secret). A fixture that drifts from the store fails closed, which is
  // the behaviour under test here.
  const iv = Buffer.alloc(12, 7)
  const key = createHash('sha256').update(secret, 'utf8').digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`
}

/** A ZCode data root holding one sign-in, exactly where the CLI writes it. */
async function credentialRoot(claims = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-http-'))
  const stateDir = join(root, '.zcode', 'v2')
  await mkdir(stateDir, { recursive: true })
  const env = { ZCODE_CREDENTIAL_SECRET: TEST_SECRET, ...claims }
  await writeFile(
    join(stateDir, 'credentials.json'),
    JSON.stringify({ zcodejwttoken: encryptValue(TEST_JWT, deriveCredentialSecret(env)) }),
  )
  await writeFile(join(stateDir, 'telemetry-state.json'), JSON.stringify({ deviceMid: TEST_DEVICE }))
  return { root, env }
}

function freeRequest(root, extra = {}) {
  return {
    channel: 'free',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hello' }],
    dataBaseDir: root,
    env: { ZCODE_CREDENTIAL_SECRET: TEST_SECRET },
    ...extra,
  }
}

/** A `Response`-like object whose body yields the given SSE text in chunks. */
function sseResponse(text, { status = 200, contentType = 'text/event-stream' } = {}) {
  const bytes = new TextEncoder().encode(text)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    text: async () => text,
  }
}

function jsonResponse(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    text: async () => text,
  }
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

const HAPPY_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":3}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

test('the free channel targets the captured zcode-plan Anthropic base URL', () => {
  assert.equal(resolveZcodeHttpEndpoint('free'), `${ZCODE_FREE_BASE_URL}/v1/messages`)
})

test('the paid channel targets the documented bigmodel base URL', () => {
  assert.equal(resolveZcodeHttpEndpoint('paid'), `${DEFAULT_PAID_BASE_URL}/v1/messages`)
})

test('an endpoint that already ends with the messages path is not doubled', () => {
  assert.equal(
    resolveZcodeHttpEndpoint('paid', 'https://example.test/anthropic/v1/messages'),
    'https://example.test/anthropic/v1/messages',
  )
  assert.equal(resolveZcodeHttpEndpoint('paid', 'https://example.test/'), 'https://example.test/v1/messages')
})

test('the free channel fails closed when the data root is unset', async () => {
  await assert.rejects(
    () => resolveZcodeHttpAuth({ channel: 'free', model: 'm', messages: [], env: {} }),
    (error) => error instanceof ZcodeError && error.code === 'ZCODE_ENV_MISSING' && /ZCODE_DATA_BASE_DIR/.test(error.message),
  )
})

test('the paid channel fails closed when no API key is present', async () => {
  await assert.rejects(
    () => resolveZcodeHttpAuth({ channel: 'paid', model: 'm', messages: [], env: {} }),
    (error) => error instanceof ZcodeError && error.code === 'ZCODE_ENV_MISSING' && error.message.includes(ZCODE_PAID_API_KEY_ENV),
  )
})

test('the paid channel prefers an explicit key over the environment', async () => {
  const auth = await resolveZcodeHttpAuth({
    channel: 'paid',
    model: 'm',
    messages: [],
    apiKey: 'explicit-key',
    env: { [ZCODE_PAID_API_KEY_ENV]: 'env-key' },
  })
  assert.equal(auth.headers['x-api-key'], 'explicit-key')
  assert.equal(auth.headers['authorization'], 'Bearer explicit-key')
  assert.equal(auth.deviceMid, undefined)
})

test('the free channel reads the encrypted store and binds the device id', async () => {
  const { root } = await credentialRoot()
  try {
    const auth = await resolveZcodeHttpAuth(freeRequest(root))
    assert.equal(auth.deviceMid, TEST_DEVICE)
    assert.equal(auth.headers['authorization'], `Bearer ${TEST_JWT}`)
    assert.equal(auth.headers['x-device-mid'], TEST_DEVICE)
    assert.equal(auth.headers['anthropic-version'], ZCODE_ANTHROPIC_VERSION)
    assert.equal(auth.headers['x-title'], 'Z Code@cli')
    assert.equal(auth.url, `${ZCODE_FREE_BASE_URL}/v1/messages`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the body mirrors the captured turn: prefix blocks, thinking, effort, stream', async () => {
  const { root } = await credentialRoot()
  try {
    const request = freeRequest(root, { system: ['caller system'] })
    const auth = await resolveZcodeHttpAuth(request)
    const body = buildZcodeHttpBody(request, auth)
    assert.equal(body.model, 'GLM-5.3-Flash')
    assert.equal(body.max_tokens, ZCODE_HTTP_DEFAULT_MAX_TOKENS)
    assert.equal(body.stream, true)
    assert.deepEqual(body.thinking, { type: 'enabled' })
    assert.deepEqual(body.output_config, { effort: 'high' })
    assert.equal(body.tools, undefined, 'toolPolicy=reject must not advertise tools')

    const system = body.system
    assert.equal(system.length, ZCODE_SYSTEM_PREFIX_BLOCKS.length + 1)
    system.slice(0, 3).forEach((block, index) => {
      assert.equal(block.text, ZCODE_SYSTEM_PREFIX_BLOCKS[index].text)
      assert.equal(block.text.length, ZCODE_SYSTEM_PREFIX_CHARS[index])
    })
    assert.equal(system[0].cache_control, undefined)
    assert.deepEqual(system[1].cache_control, { type: 'ephemeral' })
    assert.deepEqual(system[2].cache_control, { type: 'ephemeral' })
    assert.equal(system[3].text, 'caller system')

    const metadata = JSON.parse(body.metadata.user_id)
    assert.equal(metadata.device_id, TEST_DEVICE)
    assert.equal(metadata.account_uuid, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the paid body carries no device metadata', async () => {
  const request = { channel: 'paid', model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }], apiKey: 'k' }
  const auth = await resolveZcodeHttpAuth({ ...request, env: {} })
  const body = buildZcodeHttpBody(request, auth)
  assert.equal(body.metadata, undefined)
})

test('adjacent same-role messages merge instead of being dropped', async () => {
  const merged = mergeHttpMessages([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'assistant', content: 'd' },
  ])
  assert.deepEqual(merged, [
    { role: 'user', content: 'a\n\nb' },
    { role: 'assistant', content: 'c\n\nd' },
  ])
})

test('a request with no message is refused before any socket opens', async () => {
  const request = { channel: 'paid', model: 'm', messages: [], apiKey: 'k', env: {} }
  const auth = await resolveZcodeHttpAuth(request)
  assert.throws(() => buildZcodeHttpBody(request, auth), (error) => error.code === 'UNSUPPORTED_CONTENT')
})

test('the stream yields thinking, text, usage and one stop in wire order', async () => {
  const { root } = await credentialRoot()
  try {
    const events = await collect(
      streamZcodeHttp(
        freeRequest(root, {
          fetchImpl: async () => sseResponse(HAPPY_SSE),
        }),
      ),
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['usage', 'thinking', 'text', 'text', 'usage', 'stop', 'stop'],
    )
    assert.equal(events[1].text, 'pondering')
    assert.equal(events[2].text + events[3].text, 'Hello')
    assert.deepEqual(events[0].usage, { inputTokens: 11, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0 })
    assert.equal(events[4].usage.outputTokens, 5)
    assert.equal(events[5].reason, 'end_turn')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a stream that ends without any terminal frame is a parse failure, not an answer', async () => {
  const { root } = await credentialRoot()
  const truncated = HAPPY_SSE.slice(0, HAPPY_SSE.indexOf('event: message_delta'))
  try {
    await assert.rejects(
      () => collect(streamZcodeHttp(freeRequest(root, { fetchImpl: async () => sseResponse(truncated) }))),
      (error) => error instanceof ZcodeError && error.code === 'ZCODE_PARSE' && /truncated/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a stop_reason without a trailing message_stop still completes the turn', async () => {
  const { root } = await credentialRoot()
  const withoutStop = HAPPY_SSE.slice(0, HAPPY_SSE.indexOf('event: message_stop'))
  try {
    const events = await collect(
      streamZcodeHttp(freeRequest(root, { fetchImpl: async () => sseResponse(withoutStop) })),
    )
    const stop = events.find((event) => event.type === 'stop')
    assert.equal(stop.reason, 'end_turn')
    assert.equal(
      events.filter((event) => event.type === 'text').map((event) => event.text).join(''),
      'Hello',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a data frame that is not JSON fails closed', async () => {
  const { root } = await credentialRoot()
  try {
    await assert.rejects(
      () =>
        collect(
          streamZcodeHttp(
            freeRequest(root, {
              fetchImpl: async () => sseResponse('event: content_block_delta\ndata: not-json\n\n'),
            }),
          ),
        ),
      (error) => error.code === 'ZCODE_PARSE',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a non-streaming JSON answer is accepted instead of reading as empty', async () => {
  const { root } = await credentialRoot()
  try {
    const events = await collect(
      streamZcodeHttp(
        freeRequest(root, {
          fetchImpl: async () =>
            jsonResponse({
              type: 'message',
              content: [{ type: 'text', text: 'whole answer' }],
              usage: { input_tokens: 4, output_tokens: 2 },
              stop_reason: 'end_turn',
            }),
        }),
      ),
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['text', 'usage', 'stop'],
    )
    assert.equal(events[0].text, 'whole answer')
    assert.equal(events[2].reason, 'end_turn')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an in-stream error payload is classified like an HTTP failure', async () => {
  const { root } = await credentialRoot()
  try {
    await assert.rejects(
      () =>
        collect(
          streamZcodeHttp(
            freeRequest(root, {
              fetchImpl: async () =>
                sseResponse('event: error\ndata: {"type":"error","error":{"code":1309,"message":"plan expired"}}\n\n'),
            }),
          ),
        ),
      (error) => error instanceof ZcodeError && error.code === 'QUOTA' && error.providerCode === 1309,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const CLASSIFICATION = [
  ['429 without a provider code', 429, '{"message":"too many"}', 'RATE_LIMIT'],
  ['429 carrying 1309', 429, '{"code":1309,"message":"plan expired"}', 'QUOTA'],
  ['3012 permission', 400, '{"providerCode":3012,"message":"no access"}', 'PERMISSION_REQUIRED'],
  ['3007 throughput', 400, '{"code":3007}', 'RATE_LIMIT'],
  ['3001 shape', 400, '{"code":3001}', 'ZCODE_HTTP'],
  ['401 identity', 401, '{"message":"bad token"}', 'AUTH'],
  ['403 identity', 403, '{}', 'AUTH'],
  ['404 model', 404, '{"message":"no such model"}', 'MODEL_NOT_FOUND'],
  ['400 unclassified', 400, '{"message":"bad shape"}', 'ZCODE_HTTP'],
  ['500 outage', 500, '{"message":"boom"}', 'ZCODE_UNKNOWN'],
  ['503 outage', 503, '', 'ZCODE_UNKNOWN'],
]

for (const [label, status, body, code] of CLASSIFICATION) {
  test(`classify ${label} as ${code}`, () => {
    const error = classifyZcodeHttpFailure(status, body)
    assert.equal(error.code, code)
    assert.equal(error.responseStatus, status)
  })
}

test('a risk-control rejection without a provider code is a permission failure', () => {
  const error = classifyZcodeHttpFailure(400, '{"message":"unusual activity detected"}')
  assert.equal(error.code, 'PERMISSION_REQUIRED')
})

test('provider codes are read from every shape the service uses', () => {
  assert.equal(extractProviderCode('{"providerCode":3012}'), 3012)
  assert.equal(extractProviderCode('{"code":"1309"}'), 1309)
  assert.equal(extractProviderCode('[1309] PLAN_EXPIRED'), 1309)
  assert.equal(extractProviderCode('{"message":"nothing here"}'), undefined)
})

test('a failure body never repeats the credential it echoed', () => {
  const error = classifyZcodeHttpFailure(401, '{"message":"Bearer abcdefghijklmnop rejected"}')
  assert.equal(error.providerMessage, '{"message":"Bearer *** rejected"}')
  assert.ok(!(error.providerMessage ?? '').includes('abcdefghijklmnop'))
})

test('a non-2xx response becomes a ZcodeError carrying the status', async () => {
  const { root } = await credentialRoot()
  try {
    await assert.rejects(
      () =>
        collect(
          streamZcodeHttp(
            freeRequest(root, {
              fetchImpl: async () => jsonResponse({ code: 1309, message: 'plan expired' }, 429),
            }),
          ),
        ),
      (error) => error.code === 'QUOTA' && error.responseStatus === 429 && error.providerCode === 1309,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a transport failure is one retryable ZCODE_UNKNOWN, not a fake answer', async () => {
  const { root } = await credentialRoot()
  try {
    await assert.rejects(
      () =>
        collect(
          streamZcodeHttp(
            freeRequest(root, {
              fetchImpl: async () => {
                throw new Error('getaddrinfo ENOTFOUND zcode.z.ai')
              },
            }),
          ),
        ),
      (error) => error.code === 'ZCODE_UNKNOWN' && /ENOTFOUND/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the caller signal aborts the request as ABORTED', async () => {
  const { root } = await credentialRoot()
  const controller = new AbortController()
  try {
    await assert.rejects(
      () =>
        collect(
          streamZcodeHttp(
            freeRequest(root, {
              signal: controller.signal,
              fetchImpl: async (_url, init) =>
                await new Promise((_resolve, reject) => {
                  init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                  controller.abort()
                }),
            }),
          ),
        ),
      (error) => error.code === 'ABORTED',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a request that never completes is TIMEOUT, not a hang', async () => {
  const { root } = await credentialRoot()
  try {
    await assert.rejects(
      () =>
        collect(
          streamZcodeHttp(
            freeRequest(root, {
              timeoutMs: 5,
              fetchImpl: async (_url, init) =>
                await new Promise((_resolve, reject) => {
                  init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                }),
            }),
          ),
        ),
      (error) => error.code === 'TIMEOUT',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unknown frame type is ignored rather than fatal', () => {
  const state = { usage: undefined, sawStop: false }
  assert.deepEqual(mapZcodeSsePayload({ type: 'ping' }, state), [])
  assert.deepEqual(mapZcodeSsePayload({ type: 'content_block_stop' }, state), [])
  assert.equal(state.sawStop, false)
})

// ---------------------------------------------------------------------------
// Adapter over the Messages endpoint
// ---------------------------------------------------------------------------

/** Stub `fetch` for one test; every call is recorded for assertions. */
function stubFetch(t, respond) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init?.body ?? '{}')) })
    return respond({ url: String(url), init })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

const savedEnv = new Map()

/** Set (or delete, with `undefined`) a host variable for one test. */
function useEnv(t, values) {
  for (const [name, value] of Object.entries(values)) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    savedEnv.clear()
  })
}

function httpAdapter(t, overrides = {}) {
  return new ZcodeAdapter(
    {
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      channel: 'free',
      sessionStorePath: overrides.sessionStorePath ?? join(tmpdir(), `zcode-http-sessions-${Math.random().toString(36).slice(2)}.json`),
      ...overrides,
    },
    { logger: () => {} },
  )
}

function httpRequest(text = 'hi', extra = {}) {
  return {
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    sessionId: 'conversation-http',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...extra,
  }
}

async function collectChunks(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function finishFailure(chunks) {
  const last = chunks.at(-1)
  assert.equal(last?.type, 'finish', 'every stream must end with a finish chunk')
  return last.reason.kind === 'error' ? last.reason.failure : undefined
}

test('channel "cli" never opens an HTTP request', async (t) => {
  const calls = stubFetch(t, () => jsonResponse({}))
  const instance = httpAdapter(t, { channel: 'cli', nodePath: join(tmpdir(), 'no-such-node-binary') })
  const chunks = await collectChunks(instance.stream(httpRequest('hello')))
  assert.equal(calls.length, 0, 'the cli channel must go through the process layer')
  assert.ok(finishFailure(chunks) !== undefined, 'a missing node binary must fail the turn')
})

test('the free channel streams text with the CLI frame order', async (t) => {
  const { root, env } = await credentialRoot()
  const calls = stubFetch(t, () => sseResponse(HAPPY_SSE))
  useEnv(t, {
    ZCODE_DATA_BASE_DIR: root,
    ZCODE_CREDENTIAL_SECRET: env.ZCODE_CREDENTIAL_SECRET,
    ZCODE_PAID_API_KEY: undefined,
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const chunks = await collectChunks(httpAdapter(t).stream(httpRequest('hello there')))
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.equal(chunks[1].text + chunks[2].text, 'Hello')
  assert.equal(chunks[3].block.text, 'Hello')
  assert.equal(chunks[4].usage.inputTokens, 11)
  assert.equal(chunks[4].usage.outputTokens, 5)
  assert.deepEqual(chunks[5].reason, { kind: 'stop' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${ZCODE_FREE_BASE_URL}/v1/messages`)
  assert.equal(calls[0].init.headers['x-device-mid'], TEST_DEVICE)
  assert.equal(calls[0].body.model, 'GLM-5.3-Flash')
  assert.equal(calls[0].body.messages.length, 1)
  assert.deepEqual(calls[0].body.messages[0], { role: 'user', content: [{ type: 'text', text: 'hello there' }] })
})

test('the HTTP channel honors maxTokens, temperature and stop instead of refusing them', async (t) => {
  const { root, env } = await credentialRoot()
  const calls = stubFetch(t, () => sseResponse(HAPPY_SSE))
  useEnv(t, { ZCODE_DATA_BASE_DIR: root, ZCODE_CREDENTIAL_SECRET: env.ZCODE_CREDENTIAL_SECRET })
  t.after(() => rm(root, { recursive: true, force: true }))

  const chunks = await collectChunks(
    httpAdapter(t).stream(httpRequest('hi', { maxTokens: 512, temperature: 0.3, stop: ['END'] })),
  )
  assert.equal(finishFailure(chunks), undefined)
  assert.equal(calls[0].body.max_tokens, 512)
  assert.equal(calls[0].body.temperature, 0.3)
  assert.deepEqual(calls[0].body.stop_sequences, ['END'])
})

test('the paid channel uses the environment key and sends no device metadata', async (t) => {
  const calls = stubFetch(t, () => sseResponse(HAPPY_SSE))
  useEnv(t, { ZCODE_PAID_API_KEY: 'paid-test-key' })
  const chunks = await collectChunks(httpAdapter(t, { channel: 'paid' }).stream(httpRequest('hi')))
  assert.equal(finishFailure(chunks), undefined)
  assert.equal(calls[0].init.headers['x-api-key'], 'paid-test-key')
  assert.equal(calls[0].body.metadata, undefined)
  assert.ok(calls[0].url.startsWith(DEFAULT_PAID_BASE_URL))
})

test('an empty answer is a failure, never a quiet success', async (t) => {
  const { root, env } = await credentialRoot()
  stubFetch(t, () =>
    sseResponse('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'),
  )
  useEnv(t, { ZCODE_DATA_BASE_DIR: root, ZCODE_CREDENTIAL_SECRET: env.ZCODE_CREDENTIAL_SECRET })
  t.after(() => rm(root, { recursive: true, force: true }))
  const chunks = await collectChunks(httpAdapter(t).stream(httpRequest('hi')))
  assert.equal(finishFailure(chunks)?.code, EMPTY_RESPONSE_CODE)
})

test('a tool_use stop reason is UNSUPPORTED_TOOLS, as on the CLI channel', async (t) => {
  const { root, env } = await credentialRoot()
  stubFetch(t, () =>
    sseResponse(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n'
        + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ),
  )
  useEnv(t, { ZCODE_DATA_BASE_DIR: root, ZCODE_CREDENTIAL_SECRET: env.ZCODE_CREDENTIAL_SECRET })
  t.after(() => rm(root, { recursive: true, force: true }))
  const chunks = await collectChunks(httpAdapter(t).stream(httpRequest('hi')))
  assert.equal(finishFailure(chunks)?.code, 'UNSUPPORTED_TOOLS')
})

test('toolPolicy reject refuses tool schemas before the request opens', async (t) => {
  const calls = stubFetch(t, () => sseResponse(HAPPY_SSE))
  const tools = [{ name: 'Bash', description: 'run', parameters: { type: 'object', properties: {} } }]
  const chunks = await collectChunks(httpAdapter(t).stream(httpRequest('hi', { tools })))
  assert.equal(finishFailure(chunks)?.code, 'UNSUPPORTED_TOOLS')
  assert.equal(calls.length, 0, 'a refused request must not reach the network')
})

test('a missing credential store fails closed without throwing', async (t) => {
  const calls = stubFetch(t, () => sseResponse(HAPPY_SSE))
  useEnv(t, { ZCODE_DATA_BASE_DIR: undefined, ZCODE_CREDENTIAL_SECRET: undefined })
  const chunks = await collectChunks(httpAdapter(t).stream(httpRequest('hi')))
  const failure = finishFailure(chunks)
  assert.equal(failure?.code, 'ZCODE_ENV_MISSING')
  assert.match(String(failure?.message), /ZCODE_DATA_BASE_DIR/)
  assert.equal(calls.length, 0)
})

test('a 1309 answer surfaces as QUOTA with the provider code', async (t) => {
  const { root, env } = await credentialRoot()
  stubFetch(t, () => jsonResponse({ code: 1309, message: 'plan expired' }, 429))
  useEnv(t, { ZCODE_DATA_BASE_DIR: root, ZCODE_CREDENTIAL_SECRET: env.ZCODE_CREDENTIAL_SECRET })
  t.after(() => rm(root, { recursive: true, force: true }))
  const chunks = await collectChunks(httpAdapter(t).stream(httpRequest('hi')))
  const failure = finishFailure(chunks)
  assert.equal(failure?.code, 'QUOTA')
  assert.match(String(failure?.message), /providerCode=1309/)
  assert.equal(failure?.status, 429)
})

test('history keeps its roles and labels non-user turns', () => {
  const messages = toHttpMessages([
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
  ])
  // The endpoint has only user/assistant turns, so the system turn and both user
  // turns become one labelled user message; the assistant answer stays separate.
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], { role: 'user', content: '# 系统提示:\nbe brief\n\none\n\ntwo' })
  assert.deepEqual(messages[1], { role: 'assistant', content: 'answer' })
})

test('a transcript that would open with an assistant turn fails closed', () => {
  assert.throws(
    () => toHttpMessages([{ role: 'assistant', content: [{ type: 'text', text: 'earlier' }] }]),
    (error) => error instanceof ZcodeError && error.code === 'UNSUPPORTED_CONTENT',
  )
})
