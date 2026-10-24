/**
 * Registration surface: what `apply()` hands the host, and what it must not do.
 *
 * `src/index.ts` is the only file that knows the route id, the settings
 * namespace and the adapter hand-off, so this file pins exactly that payload:
 * one `registerAdapter(['zcode'], …)` per mount, the settings namespace the
 * Models page keys on, the declared service list, and an adapter that is a real
 * constructible `LlmAdapter` with a `stream` method.
 *
 * Registration also runs during host boot, before any request exists, so the
 * second half of this file keeps it honest about side effects: it must not read
 * the ZCode environment contract (that check belongs to request time), start a
 * process, or write a session file.
 *
 * Note on the "no process" assertion: an ESM import of a `node:` builtin cannot
 * be re-pointed from outside the module graph, so there is no spy to install on
 * `child_process.spawn`. What is asserted instead is the strongest offline
 * equivalent: `apply` is given a `nodePath` and a `zcodeCjsPath` that cannot
 * exist, and it still mounts the adapter — so registration never executes the
 * CLI — while a `Proxy` records every host surface it touches (only `logger`
 * and `llm`, which is where a spawn would have had to come from).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../lib/index.js'
import { BundleConfig, Config } from '../lib/provider/config.js'
import { ZcodeAdapter } from '../lib/provider/zcode.js'
import { ZCODE_ENV_CONTRACT } from '../lib/zcode/process.js'

/** The frozen service list: every entry must be mounted before `apply` runs. */
const EXPECTED_INJECT = ['llm', 'sessions', 'workspaceRegistry', 'sandboxPolicy', 'permissionPresets', 'approval']

/** A config the host would hand `apply`; `enabled` is the switch this file flips. */
function config(overrides = {}) {
  return { enabled: true, model: 'GLM-5.3-Flash', ...overrides }
}

/**
 * Minimal `Context` stand-in.
 *
 * Only `logger()` and the two `llm` registration methods exist, because those
 * are the only host surfaces `apply()` is allowed to use. Anything else throws
 * instead of being absorbed by a permissive mock, and the `Proxy` below records
 * every property that was looked up at all.
 */
function fakeContext() {
  const calls = { providers: [], adapters: [], namespaces: [], logs: [], touched: [] }
  const llm = {
    registerConfigurableProviders(entries) {
      calls.providers.push(...entries)
    },
    registerAdapter(routes, adapter) {
      calls.adapters.push({ routes: [...routes], adapter })
    },
  }
  const target = {
    logger(namespace) {
      calls.namespaces.push(namespace)
      const record = level => (...args) => calls.logs.push({ level, args })
      return { info: record('info'), warn: record('warn'), error: record('error') }
    },
    llm,
  }
  const ctx = new Proxy(target, {
    get(object, key) {
      calls.touched.push(String(key))
      return Reflect.get(object, key)
    },
  })
  return { ctx, calls }
}

test('apply registers exactly one adapter on the zcode route with the frozen settings payload', async () => {
  const { ctx, calls } = fakeContext()
  await plugin.apply(ctx, config())

  // The directory entry is what renders the card on the Models page: its three
  // identity fields are the host contract, not cosmetics.
  assert.deepEqual(calls.providers, [{
    provider: 'zcode',
    displayName: 'ZCode',
    settingsNs: 'dsh-zcode-provider',
    settingsPath: [],
  }])
  // One mount, one adapter: a second registration would fight the first over
  // the same route.
  assert.equal(calls.adapters.length, 1)
  assert.deepEqual(calls.adapters[0].routes, ['zcode'])
  assert.ok(calls.adapters[0].adapter instanceof ZcodeAdapter)

  // The exported identity is the same one the payload carries; the settings
  // namespace must equal the package name, because the host matches on it.
  assert.equal(plugin.name, 'dsh-zcode-provider')
  assert.equal(plugin.ZCODE_PROVIDER_ROUTE, 'zcode')
  assert.equal(plugin.ZCODE_SETTINGS_NS, 'dsh-zcode-provider')
  assert.equal(plugin.ZCODE_DISPLAY_NAME, 'ZCode')
  assert.equal(plugin.name, calls.providers[0].settingsNs)
})

test('the plugin declares the six services it needs before apply runs', () => {
  assert.deepEqual(plugin.inject, EXPECTED_INJECT)
  assert.equal(plugin.inject.length, 6)
  // Duplicates would make the mount wait on the same service twice.
  assert.equal(new Set(plugin.inject).size, plugin.inject.length)
})

test('the registered adapter is a constructible LlmAdapter with a stream method', async () => {
  const { ctx, calls } = fakeContext()
  await plugin.apply(ctx, config())
  const { adapter } = calls.adapters[0]

  // A plain object with a `stream` key would satisfy the host but cannot be
  // rebuilt by the settings editor, so the class itself must be usable.
  assert.equal(typeof ZcodeAdapter, 'function')
  const rebuilt = new ZcodeAdapter({ model: 'GLM-5.3-Flash' }, { logger: () => {} })
  assert.equal(typeof adapter.stream, 'function')
  assert.equal(typeof rebuilt.stream, 'function')
  for (const instance of [adapter, rebuilt]) {
    assert.deepEqual(instance.providerInfo('zcode'), { id: 'zcode', name: 'ZCode' })
    assert.ok(instance instanceof ZcodeAdapter)
  }
})

test('a disabled bundle registers the directory entry but never an adapter', async () => {
  const { ctx, calls } = fakeContext()
  await plugin.apply(ctx, config({ enabled: false }))

  // The row must still exist so the user can switch the provider back on from
  // the Models page; only the adapter hand-off is skipped.
  assert.equal(calls.providers.length, 1)
  assert.equal(calls.adapters.length, 0)
})

test('A1: a host-parsed bundle registers its adapter even though enabled is a volatile reference', async () => {
  // `enabled` carries `.volatile()`, so the host hands `apply` a reference
  // object, not `true`. Comparing it with `=== true` is always false and kept
  // the adapter unregistered — this test fails if that comparison comes back.
  const bundle = BundleConfig({})
  assert.equal(typeof bundle.enabled, 'object')
  assert.equal(bundle.enabled === true, false, 'the fixture must reproduce the reference shape')

  const { ctx, calls } = fakeContext()
  await plugin.apply(ctx, bundle)
  assert.equal(calls.adapters.length, 1, 'the volatile bundle must register the adapter')
  assert.ok(calls.adapters[0].adapter instanceof ZcodeAdapter)

  // Disabling through the same reference must still skip registration.
  const disabled = BundleConfig({ enabled: false })
  const off = fakeContext()
  await plugin.apply(off.ctx, disabled)
  assert.equal(off.calls.adapters.length, 0)
})

test('A1: every enabled shape the host can hand over is unwrapped, a bare reference included', async () => {
  const shapes = [
    [true, 1],
    [false, 0],
    [{ isVolatile: true, get: () => true }, 1],
    [{ isVolatile: true, get: () => false }, 0],
    [Config({}), 0],
  ]
  for (const [enabled, expected] of shapes) {
    const { ctx, calls } = fakeContext()
    await plugin.apply(ctx, { ...config(), enabled })
    assert.equal(calls.adapters.length, expected, `enabled=${JSON.stringify(enabled)}`)
  }
})

test('registration has no boot-time side effects: no env read, no process, no file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-register-'))
  const sessionDirectory = join(root, 'sessions')
  const saved = ZCODE_ENV_CONTRACT.map(entry => [entry.name, process.env[entry.name]])
  try {
    // Request time is where the env contract is enforced; registration must not
    // read it, so an environment with none of the five entries still mounts.
    for (const entry of ZCODE_ENV_CONTRACT) delete process.env[entry.name]

    const { ctx, calls } = fakeContext()
    await plugin.apply(ctx, config({
      nodePath: join(root, 'no-such-node.exe'),
      zcodeCjsPath: join(root, 'no-such-zcode.cjs'),
      sessionStorePath: join(sessionDirectory, 'sessions.json'),
    }))

    // 1. It mounted anyway: a missing contract is a request-time failure, and
    //    paths that cannot be spawned were never validated or executed.
    assert.equal(calls.adapters.length, 1)
    // 2. Nothing was created on disk: the adapter's session store is lazy, and
    //    its directory must not appear just because a plugin mounted.
    assert.equal(existsSync(sessionDirectory), false)
    assert.deepEqual(readdirSync(root), [])
    // 3. It neither required nor set any contract variable.
    assert.deepEqual(
      ZCODE_ENV_CONTRACT.filter(entry => process.env[entry.name] !== undefined).map(entry => entry.name),
      [],
    )
    // 4. The only host surfaces touched are registration (`llm`, `logger`) and
    //    the optional web route mount (`inject`), which is wrapped in try/catch:
    //    a host without a web server must still mount the adapter. A spawn or a
    //    file write would need another service and would show up here.
    assert.deepEqual([...new Set(calls.touched)].sort(), ['inject', 'llm', 'logger'])
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * `createWorkspaceRootResolver` is the only place that turns a conversation into
 * a `--cwd`, and the adapter turns `undefined` into `WORKSPACE_UNAVAILABLE`. The
 * two tests below pin both halves: the happy path must answer with the registry
 * root of *this* session, and every broken link must answer `undefined` instead
 * of falling back to `process.cwd()` (the DSH install directory, not the user's
 * project). Losing either one is how a provider silently writes into the
 * installation folder; the doc states the rule, these tests make it fail.
 */
test('B2: the workspace resolver answers with the session registry root, not the process cwd', async () => {
  const asked = []
  const ctx = {
    sessions: {
      get: id => (id === 'conversation-ws' ? { header: { cwd: 'F:\\defws\\project' } } : undefined),
    },
    workspaceRegistry: {
      resolveByPath: async path => {
        asked.push(path)
        return { path: 'F:\\defws\\project\\workspace', status: async () => 'ok' }
      },
    },
  }

  const resolver = plugin.createWorkspaceRootResolver(ctx)
  const root = await resolver('conversation-ws')

  assert.equal(root, 'F:\\defws\\project\\workspace')
  assert.deepEqual(asked, ['F:\\defws\\project'], 'the registry must be asked about this session\'s cwd')
  assert.notEqual(root, process.cwd(), 'a resolver that returned process.cwd() would run the CLI in the DSH install')
})

test('B2: the workspace resolver fails closed on every broken link, never to the process cwd', async () => {
  const cwd = 'F:\\defws\\project'
  const session = () => ({ header: { cwd } })
  const ok = () => ({ path: 'F:\\defws\\project\\workspace', status: async () => 'ok' })
  const cases = [
    ['no host services at all', {}],
    ['no registry', { sessions: { get: session } }],
    ['an unknown conversation', { sessions: { get: () => undefined }, workspaceRegistry: { resolveByPath: async ok2 => ok() } }],
    ['a blank recorded cwd', { sessions: { get: () => ({ header: { cwd: '  ' } }) }, workspaceRegistry: { resolveByPath: async () => ok() } }],
    ['a registry that resolves nothing', { sessions: { get: session }, workspaceRegistry: { resolveByPath: async () => undefined } }],
    ['a registry without resolveByPath', { sessions: { get: session }, workspaceRegistry: {} }],
    ['a workspace whose status is not ok', { sessions: { get: session }, workspaceRegistry: { resolveByPath: async () => ({ ...ok(), status: async () => 'deleted' }) } }],
  ]

  for (const [label, ctx] of cases) {
    const resolver = plugin.createWorkspaceRootResolver(ctx)
    const resolved = await resolver('conversation-ws')
    assert.equal(resolved, undefined, `${label}: must not resolve`)
    assert.notEqual(resolved, process.cwd(), `${label}: must not fall back to the process cwd`)
  }

  // The status seam is optional: a registry that exposes no `status()` is
  // trusted as-is (a host without that field must not be unusable).
  const statusless = plugin.createWorkspaceRootResolver({
    sessions: { get: session },
    workspaceRegistry: { resolveByPath: async () => ({ path: 'F:\\defws\\project\\workspace' }) },
  })
  assert.equal(await statusless('conversation-ws'), 'F:\\defws\\project\\workspace')
})