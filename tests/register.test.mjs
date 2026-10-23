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
    // 4. The only host surface touched is the one registration is allowed to
    //    touch; a spawn or a file write would need another service.
    assert.deepEqual([...new Set(calls.touched)].sort(), ['llm', 'logger'])
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})