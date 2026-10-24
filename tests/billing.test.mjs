/**
 * Offline contract tests for the quota read path.
 *
 * The rule for this file: no real credential store, no real network. The token
 * is encrypted here with a fixed secret and a fixed IV; every `fetch` is a mock
 * that records what it was handed. `tests/env.test.mjs` and the gate in
 * `scripts/run-tests.mjs` keep the rest of the suite honest about that.
 */

import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ZcodeError } from '../lib/provider/error-codes.js'
import {
  ZCODE_BILLING_CACHE_TTL_MS,
  ZCODE_BILLING_URL,
  createBillingReader,
  decryptCredentialValue,
  deriveCredentialSecret,
  fetchBillingSnapshot,
} from '../lib/zcode/billing.js'
import {
  BILLING_ROUTE_PATH,
  createBillingHttpHandler,
  setupBillingRoutes,
} from '../lib/web/router.js'

const SECRET = 'offline-test-secret'
const TOKEN = 'offline-jwt-value'
const DEVICE_MID = 'device-mid-offline'

/** Encrypt TOKEN the way the ZCode credential store does. */
function encryptToken(secret = SECRET, plaintext = TOKEN, iv = Buffer.alloc(16, 7)) {
  const key = createHash('sha256').update(secret, 'utf8').digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

/** Create `<base>/.zcode/v2/{credentials,telemetry-state}.json`. */
async function makeStateDir({ token = encryptToken(), deviceMid = DEVICE_MID } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'zcode-billing-'))
  const state = join(base, '.zcode', 'v2')
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'credentials.json'), JSON.stringify({ zcodejwttoken: token }), 'utf8')
  await writeFile(join(state, 'telemetry-state.json'), JSON.stringify({ deviceMid }), 'utf8')
  return { base, state }
}

const SUCCESS_BODY = {
  code: 0,
  data: {
    server_time: 1792808985,
    plans: [{
      user_plan_id: 'upl_1',
      plan_id: 'zcode-v3-start-plan-1024',
      name: 'ZCode 1024 Dev Day',
      status: 'active',
      starts_at: 1792757905,
      ends_at: 1792976400,
      entitlements: [{
        show_name: 'GLM-5.3-Flash',
        meter: 'model_usage',
        unit_type: 'token',
        capabilities: ['model:glm-5.3-flash'],
        grant_units: 300000000,
        period: 'one_time',
      }],
    }],
    balances: [{
      show_name: 'GLM-5.3-Flash',
      total_units: 300000000,
      used_units: 0,
      remaining_units: 300000000,
      available_units: 300000000,
      period_start: 1792757905,
      period_end: 1792976400,
      expires_at: 1792976400,
      capabilities: ['model:glm-5.3-flash'],
    }],
  },
}

/** Build a mock fetch that answers once and records its arguments. */
function mockFetch(payload, { status = 200, raw = false } = {}) {
  const calls = []
  const mock = async (url, init) => {
    calls.push({ url, init })
    return new Response(raw ? payload : JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { mock, calls }
}

function assertZcodeError(code) {
  return (error) => {
    assert.ok(error instanceof ZcodeError, `expected ZcodeError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  }
}

test('the AES-256-GCM vector round-trips a fixed ciphertext', () => {
  assert.equal(decryptCredentialValue(encryptToken(), SECRET), TOKEN)
  assert.equal(decryptCredentialValue(encryptToken(SECRET, 'another-token'), SECRET), 'another-token')
})

test('a wrong secret is reported as a decrypt failure, not as an empty plan', () => {
  assert.throws(() => decryptCredentialValue(encryptToken('a-different-secret'), SECRET), assertZcodeError('ZCODE_CREDENTIAL_DECRYPT_FAILED'))
})

test('malformed credential payloads fail closed before any network call', () => {
  const vector = encryptToken()
  const [, iv, tag, ciphertext] = vector.split(/[:.]/u)
  for (const value of [
    'plain-jwt-without-prefix',
    'enc:v1:only-two.parts',
    `enc:v1:${iv}.${tag}`,
    `enc:v1:${Buffer.alloc(8, 1).toString('base64url')}.${tag}.${ciphertext}`,
    `enc:v1:${iv}.${Buffer.alloc(4, 2).toString('base64url')}.${ciphertext}`,
    `enc:v1:${iv}.${tag}.`,
    `enc:v1:${iv}.${tag}.${ciphertext}!!`,
  ]) {
    assert.throws(() => decryptCredentialValue(value, SECRET), assertZcodeError('ZCODE_CREDENTIAL_DECRYPT_FAILED'), value)
  }
})

test('the credential secret prefers ZCODE_CREDENTIAL_SECRET and falls back deterministically', () => {
  assert.equal(deriveCredentialSecret({ ZCODE_CREDENTIAL_SECRET: 'explicit' }), 'explicit')
  const env = { USERNAME: 'tester' }
  const fallback = deriveCredentialSecret(env)
  assert.equal(fallback, `zcode-credential-fallback:${process.platform}:${homedir()}:tester`)
  assert.equal(deriveCredentialSecret(env), fallback)
  assert.notEqual(deriveCredentialSecret({ USERNAME: 'someone-else' }), fallback)
})

test('a successful payload is normalised, and the request carries the documented headers', async () => {
  const { base } = await makeStateDir()
  try {
    const { mock, calls } = mockFetch(SUCCESS_BODY)
    const snapshot = await fetchBillingSnapshot(
      { ZCODE_DATA_BASE_DIR: base, USERNAME: 'tester', ZCODE_CREDENTIAL_SECRET: SECRET },
      { fetch: mock, now: () => 1234 },
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, ZCODE_BILLING_URL)
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(calls[0].init.headers['X-Device-Mid'], DEVICE_MID)
    assert.equal(calls[0].init.headers['User-Agent'], 'ZCode/3.4.0')
    assert.equal(calls[0].init.headers.Accept, 'application/json')

    assert.equal(snapshot.fetchedAt, 1234)
    assert.deepEqual(snapshot.plans, [{
      planId: 'zcode-v3-start-plan-1024',
      name: 'ZCode 1024 Dev Day',
      status: 'active',
      startsAt: 1792757905,
      endsAt: 1792976400,
      entitlements: [{
        showName: 'GLM-5.3-Flash',
        grantUnits: 300000000,
        capabilities: ['model:glm-5.3-flash'],
        unitType: 'token',
        period: 'one_time',
      }],
    }])
    assert.deepEqual(snapshot.balances, [{
      showName: 'GLM-5.3-Flash',
      totalUnits: 300000000,
      usedUnits: 0,
      remainingUnits: 300000000,
      availableUnits: 300000000,
      expiresAt: 1792976400,
      capabilities: ['model:glm-5.3-flash'],
    }])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a missing credential store is ZCODE_CREDENTIAL_MISSING', async () => {
  const base = await mkdtemp(join(tmpdir(), 'zcode-billing-'))
  try {
    const { mock, calls } = mockFetch(SUCCESS_BODY)
    await assert.rejects(
      fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
      assertZcodeError('ZCODE_CREDENTIAL_MISSING'),
    )
    assert.equal(calls.length, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an unreadable credential store is ZCODE_CREDENTIAL_INVALID', async () => {
  const base = await mkdtemp(join(tmpdir(), 'zcode-billing-'))
  const state = join(base, '.zcode', 'v2')
  await mkdir(state, { recursive: true })
  try {
    const { mock } = mockFetch(SUCCESS_BODY)
    await writeFile(join(state, 'credentials.json'), '{not json', 'utf8')
    await assert.rejects(
      fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
      assertZcodeError('ZCODE_CREDENTIAL_INVALID'),
    )
    await writeFile(join(state, 'credentials.json'), JSON.stringify({ other: 'x' }), 'utf8')
    await assert.rejects(
      fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
      assertZcodeError('ZCODE_CREDENTIAL_INVALID'),
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('missing ZCODE_DATA_BASE_DIR is ZCODE_ENV_MISSING, with no network call', async () => {
  const { mock, calls } = mockFetch(SUCCESS_BODY)
  await assert.rejects(
    fetchBillingSnapshot({}, { fetch: mock, now: () => 0 }),
    assertZcodeError('ZCODE_ENV_MISSING'),
  )
  assert.equal(calls.length, 0)
})

test('HTTP 401 and 403 map to ZCODE_BILLING_UNAUTHORIZED', async () => {
  const { base } = await makeStateDir()
  try {
    for (const status of [401, 403]) {
      const { mock } = mockFetch({ code: 1001, msg: 'unauthorized' }, { status })
      await assert.rejects(
        fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
        assertZcodeError('ZCODE_BILLING_UNAUTHORIZED'),
      )
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('HTTP 400 maps to ZCODE_BILLING_BAD_REQUEST and mentions the device id', async () => {
  const { base } = await makeStateDir({ deviceMid: '' })
  try {
    const { mock, calls } = mockFetch({ code: 3001, msg: 'parameter error' }, { status: 400 })
    await assert.rejects(
      fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
      (error) => {
        assertZcodeError('ZCODE_BILLING_BAD_REQUEST')(error)
        assert.match(error.message, /device id/u)
        assert.ok(!error.message.includes(TOKEN))
        return true
      },
    )
    assert.equal(calls[0].init.headers['X-Device-Mid'], undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('other non-2xx statuses map to ZCODE_BILLING_HTTP', async () => {
  const { base } = await makeStateDir()
  try {
    for (const status of [429, 500, 503]) {
      const { mock } = mockFetch({ msg: 'nope' }, { status })
      await assert.rejects(
        fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
        assertZcodeError('ZCODE_BILLING_HTTP'),
      )
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a business code of 3001 is BAD_REQUEST even on HTTP 200', async () => {
  const { base } = await makeStateDir()
  try {
    const { mock } = mockFetch({ code: 3001, msg: 'parameter error' })
    await assert.rejects(
      fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
      assertZcodeError('ZCODE_BILLING_BAD_REQUEST'),
    )
    const { mock: other } = mockFetch({ code: 5000, msg: 'server busy' })
    await assert.rejects(
      fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: other, now: () => 0 }),
      assertZcodeError('ZCODE_BILLING_HTTP'),
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a payload without plans/balances arrays is ZCODE_BILLING_PARSE', async () => {
  const { base } = await makeStateDir()
  try {
    const shapes = [
      { code: 0, data: { plans: [], balances: 'nope' } },
      { code: 0, data: { balances: [] } },
      { code: 0 },
      { code: 0, data: [] },
    ]
    for (const shape of shapes) {
      const { mock } = mockFetch(shape)
      await assert.rejects(
        fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: mock, now: () => 0 }),
        assertZcodeError('ZCODE_BILLING_PARSE'),
      )
    }
    const { mock: broken } = mockFetch('not-json{', { raw: true })
    await assert.rejects(
      fetchBillingSnapshot({ ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET }, { fetch: broken, now: () => 0 }),
      assertZcodeError('ZCODE_BILLING_PARSE'),
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the reader caches a success for the documented 30 seconds', async () => {
  assert.equal(ZCODE_BILLING_CACHE_TTL_MS, 30_000)
  const { base } = await makeStateDir()
  try {
    const { mock, calls } = mockFetch(SUCCESS_BODY)
    let clock = 1_000
    const reader = createBillingReader({
      fetch: mock,
      now: () => clock,
      env: { ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET },
    })
    const first = await reader.read()
    const second = await reader.read()
    assert.equal(calls.length, 1, 'a cache hit must not hit the network again')
    assert.equal(second, first, 'the cached snapshot is reused, not rebuilt')

    clock += ZCODE_BILLING_CACHE_TTL_MS - 1
    await reader.read()
    assert.equal(calls.length, 1, 'still inside the window')

    clock += 1
    await reader.read()
    assert.equal(calls.length, 2, 'the window expired, so the next read refreshes')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('?refresh=1 bypasses the cache and replaces its contents', async () => {
  const { base } = await makeStateDir()
  try {
    const { mock, calls } = mockFetch(SUCCESS_BODY)
    let clock = 5_000
    const reader = createBillingReader({ fetch: mock, now: () => clock, env: { ZCODE_DATA_BASE_DIR: base, ZCODE_CREDENTIAL_SECRET: SECRET } })
    const first = await reader.read()
    const refreshed = await reader.read({ force: true })
    assert.equal(calls.length, 2)
    assert.notEqual(refreshed, first, 'a forced read builds a new snapshot')
    assert.equal(refreshed.fetchedAt, 5_000)

    clock += 10
    const cachedAfterForce = await reader.read()
    assert.equal(calls.length, 2, 'the forced read seeded the cache')
    assert.equal(cachedAfterForce, refreshed)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ── Router ──────────────────────────────────────────────────────────────────

/** Minimal request/response pair; enough for the handler's contract. */
function fakeExchange({ method = 'GET', url = BILLING_ROUTE_PATH, remoteAddress = '127.0.0.1' } = {}) {
  const state = { status: 0, headers: {}, body: '', ended: false }
  return {
    req: { method, url, socket: { remoteAddress } },
    res: {
      headersSent: false,
      writableEnded: false,
      writeHead(status, headers) {
        state.status = status
        state.headers = headers
      },
      end(text = '') {
        state.body = text
        state.ended = true
      },
    },
    state,
  }
}

test('the route answers {ok:true} and forwards ?refresh=1 to the reader', async () => {
  const seen = []
  const reader = {
    async read(options) {
      seen.push(options)
      return { fetchedAt: 42, plans: [], balances: [] }
    },
  }
  const handler = createBillingHttpHandler(reader)
  const exchange = fakeExchange({ url: `${BILLING_ROUTE_PATH}?refresh=1` })
  await handler(exchange.req, exchange.res)

  assert.equal(exchange.state.status, 200)
  assert.equal(exchange.state.headers['Cache-Control'], 'no-store')
  assert.deepEqual(seen, [{ force: true }])
  const body = JSON.parse(exchange.state.body)
  assert.equal(body.ok, true)
  assert.deepEqual(body.data, { fetchedAt: 42, plans: [], balances: [] })
})

test('the route refuses non-GET and non-loopback peers before reading anything', async () => {
  let reads = 0
  const handler = createBillingHttpHandler({ read: async () => { reads += 1; return { fetchedAt: 0, plans: [], balances: [] } } })

  const wrongMethod = fakeExchange({ method: 'POST' })
  await handler(wrongMethod.req, wrongMethod.res)
  assert.equal(wrongMethod.state.status, 405)
  assert.equal(JSON.parse(wrongMethod.state.body).ok, false)

  const remote = fakeExchange({ remoteAddress: '10.0.0.8' })
  await handler(remote.req, remote.res)
  assert.equal(remote.state.status, 403)
  assert.equal(JSON.parse(remote.state.body).error.code, 'FORBIDDEN')

  assert.equal(reads, 0)
})

test('a failed read becomes a classified envelope, never a thrown error', async () => {
  const handler = createBillingHttpHandler({
    read: async () => {
      throw new ZcodeError('ZCODE_BILLING_UNAUTHORIZED', 'identity rejected (HTTP 401)')
    },
  })
  const exchange = fakeExchange()
  await handler(exchange.req, exchange.res)

  assert.equal(exchange.state.status, 200)
  const body = JSON.parse(exchange.state.body)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'ZCODE_BILLING_UNAUTHORIZED')
  assert.match(body.error.message, /HTTP 401/u)
})

test('setupBillingRoutes mounts one exact route and its disposer unregisters it', () => {
  const registered = []
  const disposed = []
  const injected = []
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      callback({
        webServer: {
          register(route) {
          registered.push(route)
          return () => disposed.push(route.path)
          },
        },
      })
    },
  }

  const dispose = setupBillingRoutes(ctx, {
    reader: { read: async () => ({ fetchedAt: 0, plans: [], balances: [] }) },
  })
  assert.deepEqual(injected, [['webServer']])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'exact')
  assert.equal(registered[0].path, BILLING_ROUTE_PATH)

  dispose()
  assert.deepEqual(disposed, [BILLING_ROUTE_PATH])
})

test('setupBillingRoutes survives a host without a web server', () => {
  const ctx = { inject: (names, callback) => callback({}) }
  const dispose = setupBillingRoutes(ctx)
  assert.equal(typeof dispose, 'function')
  dispose()
})

/* ── A2 settings-page surface (state + quota routes) ────────────────────── */
import { createServer } from 'node:http'

import {
  ZCODE_QUOTA_ROUTE_PATH,
  ZCODE_STATE_ROUTE_PATH,
  createZcodeWebRoutes,
  mergeQuotaSnapshot,
} from '../lib/web/router.js'
import { BillingError } from '../lib/zcode/billing.js'
import { DEFAULT_MODELS } from '../lib/provider/config.js'

function snapshot() {
  return {
    fetchedAt: '2026-10-24T03:00:00.000Z',
    plans: [{
      planId: 'plan-1',
      name: 'ZCode 1024 Dev Day',
      status: 'active',
      startsAt: '2026-10-21T00:00:00.000Z',
      endsAt: '2026-10-26T01:00:00.000Z',
      remainingMs: 86_400_000,
      entitlements: [
        { modelId: 'GLM-5.3-Flash', grantUnits: 300_000_000 },
        { modelId: 'GLM-5.3', grantUnits: 200_000_000 },
      ],
    }],
    balances: [
      { modelId: 'GLM-5.3-Flash', usedUnits: 30_000_000, remainingUnits: 270_000_000 },
      { modelId: 'GLM-5.3', usedUnits: 0, remainingUnits: 200_000_000 },
      { modelId: 'orphan-model', usedUnits: 5, remainingUnits: 5 },
    ],
  }
}

function mount(deps) {
  const registered = []
  const routes = createZcodeWebRoutes(deps)
  routes.register({
    register(route) {
      registered.push(route)
      return () => {}
    },
  })
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const route = registered.find((entry) => entry.path === path)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  return { server, registered }
}

function request(server, path, options = {}) {
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}${path}`
  return new Promise((resolve, reject) => {
    import('node:http').then(({ request: httpRequest }) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
      const req = httpRequest(url, {
        method: options.method ?? 'GET',
        headers: payload === undefined
          ? { connection: 'close' }
          : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), connection: 'close' },
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  })
}

async function withServer(deps, body) {
  const mounted = mount(deps)
  await new Promise((resolve) => mounted.server.listen(0, '127.0.0.1', resolve))
  try {
    return await body(mounted.server)
  } finally {
    mounted.server.close()
  }
}

const baseDeps = () => ({
  getConfig: () => ({ channel: 'free', model: 'GLM-5.3-Flash', effort: 'medium' }),
  setSelection: async () => {},
  dataBaseDir: '/virtual/data-root',
  quotaReader: { read: async () => snapshot() },
})

test('A2: GET /state exposes the frozen contract', async () => {
  await withServer(baseDeps(), async (server) => {
    const response = await request(server, ZCODE_STATE_ROUTE_PATH)
    assert.equal(response.status, 200)
    assert.equal(response.body.channel, 'free')
    assert.equal(response.body.model, 'GLM-5.3-Flash')
    assert.equal(response.body.effort, 'medium')
    assert.deepEqual(response.body.models.map((m) => m.id), DEFAULT_MODELS.map((m) => m.id))
    assert.deepEqual(response.body.efforts.map((e) => e.id), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(response.body.channels.map((c) => c.id), ['free', 'paid', 'cli'])
    assert.equal(response.body.channels.every((c) => c.available === true), true)
  })
})

test('A2: POST /state applies only the supplied fields', async () => {
  let current = { channel: 'free', model: 'GLM-5.3-Flash', effort: 'medium' }
  const applied = []
  const deps = {
    ...baseDeps(),
    getConfig: () => current,
    setSelection: async (patch) => {
      applied.push(patch)
      current = { ...current, ...patch }
    },
  }
  await withServer(deps, async (server) => {
    const response = await request(server, ZCODE_STATE_ROUTE_PATH, { method: 'POST', body: { effort: 'max' } })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.deepEqual(applied, [{ effort: 'max' }])
    assert.equal(response.body.state.effort, 'max')
    assert.equal(response.body.state.channel, 'free')
    assert.equal(response.body.state.model, 'GLM-5.3-Flash')
  })
})

test('A2: POST /state rejects unknown fields and illegal values with 400', async () => {
  let calls = 0
  const deps = { ...baseDeps(), setSelection: async () => { calls += 1 } }
  await withServer(deps, async (server) => {
    const unknown = await request(server, ZCODE_STATE_ROUTE_PATH, { method: 'POST', body: { channel: 'free', nonsense: 1 } })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.ok, false)
    assert.equal(unknown.body.error, 'UNKNOWN_FIELD')
    for (const [body, code] of [
      [{ channel: 'bogus' }, 'INVALID_CHANNEL'],
      [{ model: 'GLM-9' }, 'INVALID_MODEL'],
      [{ effort: 'turbo' }, 'INVALID_EFFORT'],
    ]) {
      const response = await request(server, ZCODE_STATE_ROUTE_PATH, { method: 'POST', body })
      assert.equal(response.status, 400)
      assert.equal(response.body.error, code)
    }
    const malformed = await request(server, ZCODE_STATE_ROUTE_PATH, { method: 'POST', body: [1, 2] })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.error, 'INVALID_BODY')
    assert.equal(calls, 0)
  })
})

test('A2: GET /quota returns the snapshot plus merged rows by modelId', async () => {
  let seenRefresh = null
  const deps = {
    ...baseDeps(),
    quotaReader: { read: async ({ refresh }) => { seenRefresh = refresh; return snapshot() } },
  }
  await withServer(deps, async (server) => {
    const plain = await request(server, ZCODE_QUOTA_ROUTE_PATH)
    assert.equal(plain.status, 200)
    assert.equal(plain.body.ok, true)
    assert.equal(plain.body.quota.fetchedAt, '2026-10-24T03:00:00.000Z')
    assert.equal(seenRefresh, false)
    const flash = plain.body.merged.find((m) => m.modelId === 'GLM-5.3-Flash')
    assert.deepEqual(flash, { modelId: 'GLM-5.3-Flash', grantUnits: 300_000_000, usedUnits: 30_000_000, remainingUnits: 270_000_000, percentUsed: 10 })
    const orphan = plain.body.merged.find((m) => m.modelId === 'orphan-model')
    assert.equal(orphan.grantUnits, null)
    const refreshed = await request(server, `${ZCODE_QUOTA_ROUTE_PATH}?refresh=1`)
    assert.equal(refreshed.status, 200)
    assert.equal(seenRefresh, true)
  })
})

test('A2: GET /quota maps missing credentials to 503 with a machine code', async () => {
  const deps = {
    ...baseDeps(),
    quotaReader: { read: async () => { throw new BillingError('ZCODE_CREDENTIAL_MISSING', 'no store') } },
  }
  await withServer(deps, async (server) => {
    const response = await request(server, ZCODE_QUOTA_ROUTE_PATH)
    assert.equal(response.status, 503)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error, 'ZCODE_CREDENTIAL_MISSING')
    assert.equal(/at\s+\S+\s+\(/.test(JSON.stringify(response.body)), false)
  })
})

test('A2: GET /quota maps upstream failures to 502', async () => {
  const deps = {
    ...baseDeps(),
    quotaReader: { read: async () => { throw new BillingError('ZCODE_BILLING_HTTP', 'upstream 500', { responseStatus: 500 }) } },
  }
  await withServer(deps, async (server) => {
    const response = await request(server, ZCODE_QUOTA_ROUTE_PATH)
    assert.equal(response.status, 502)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error, 'ZCODE_BILLING_HTTP')
    assert.equal(typeof response.body.detail, 'string')
  })
})

test('A2: mergeQuotaSnapshot aligns, dedupes and skips nameless rows', () => {
  const merged = mergeQuotaSnapshot(snapshot())
  assert.deepEqual(merged.map((m) => m.modelId), ['GLM-5.3-Flash', 'GLM-5.3', 'orphan-model'])
  const glm = merged.find((m) => m.modelId === 'GLM-5.3')
  assert.equal(glm.percentUsed, 0)
  const grantsOnly = mergeQuotaSnapshot({
    fetchedAt: 'x',
    plans: [{ planId: null, name: null, status: null, startsAt: null, endsAt: null, remainingMs: null, entitlements: [{ modelId: 'a', grantUnits: 100 }] }],
    balances: [],
  })
  assert.deepEqual(grantsOnly, [{ modelId: 'a', grantUnits: 100, usedUnits: null, remainingUnits: null, percentUsed: null }])
})
