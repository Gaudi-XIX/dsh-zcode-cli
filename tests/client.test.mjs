/**
 * Contract tests for the browser half (`client/`).
 *
 * The card is a *static* mirror of the Node half: it cannot import
 * `src/provider/config.ts` (that would pull `@deepseek-ai/schemastery` and the
 * adapter's module graph into the browser bundle), so every value it shows is a
 * literal copied by hand. This file is the pin: if the Node half moves and the
 * card is not updated with it, the gate goes red here instead of the settings
 * page quietly lying about the model catalog or the environment contract.
 *
 * Nothing here executes `dist/client.js`: it needs the host's `require('react')`
 * to load. The bundle is checked by `scripts/build-client.mjs` (build) and by
 * the static smoke assertions in the handoff; these cases read source text.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string} relative - Package-relative path. @returns {string} */
const read = relative => readFileSync(join(root, relative), 'utf8')

const manifest = JSON.parse(read('package.json'))
const clientEntry = read('client/index.ts')
const clientLocales = read('client/locales.ts')
const nodeEntry = read('src/index.ts')
const nodeConfig = read('src/provider/config.ts')
const nodeProcess = read('src/zcode/process.ts')

test('manifest declares a web client half and exports it', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, ['@deepseek-ai/dsh-client-ui-primitives'])
  assert.equal(manifest.exports?.['./client'], './dist/client.js')
  assert.ok(
    (manifest.files ?? []).includes('dist/**/*.js'),
    'a published package must ship dist/client.js, or the exported client path is missing for every consumer',
  )
})

test('the card registers on the slot key equal to the Node half settings namespace', () => {
  const settingsNs = nodeEntry.match(/export const ZCODE_SETTINGS_NS = '([^']+)'/)?.[1]
  assert.ok(settingsNs !== undefined, 'src/index.ts no longer declares ZCODE_SETTINGS_NS')
  const route = nodeEntry.match(/export const ZCODE_PROVIDER_ROUTE = '([^']+)'/)?.[1]
  assert.ok(route !== undefined, 'src/index.ts no longer declares ZCODE_PROVIDER_ROUTE')

  // The host matches the registered `key` against the row's entryKey (the
  // settingsNs) verbatim; a literal mismatch is the empty-row bug again.
  assert.ok(
    clientEntry.includes(`const SETTINGS_NS = '${settingsNs}'`),
    `client SETTINGS_NS must be the literal '${settingsNs}'`,
  )
  assert.match(clientEntry, /ctx\.slots\.inject\('settings\.models\.provider-card'/)
  assert.match(clientEntry, /name: 'settings\.models\.provider-card'/)
  assert.match(clientEntry, /key: SETTINGS_NS/)
  assert.match(clientEntry, /id: CARD_ID/)
  assert.match(clientEntry, /const CARD_ID = 'zcode-provider-card'/)
  assert.ok(clientEntry.includes(`const PROVIDER_ROUTE = '${route}'`))
})

test('the panel mirrors the model catalog, defaults and environment contract', () => {
  // Model catalog: ids come from DEFAULT_MODELS, the default from DEFAULT_MODEL.
  const modelIds = [...nodeConfig.matchAll(/\{ id: '([^']+)', name:/g)].map(match => match[1])
  assert.deepEqual(modelIds, ['GLM-5.3-Flash', 'GLM-5.3'], 'DEFAULT_MODELS changed shape; update the regex and the card together')
  const mirrored = clientEntry.match(/const MODELS: readonly string\[\] = \[([^\]]+)\]/)?.[1]
  assert.ok(mirrored !== undefined, 'client/index.ts no longer declares a MODELS mirror')
  for (const id of modelIds) assert.ok(mirrored.includes(`'${id}'`), `card is missing model ${id}`)

  const defaultModel = nodeConfig.match(/export const DEFAULT_MODEL = '([^']+)'/)?.[1]
  assert.ok(defaultModel !== undefined)
  assert.ok(clientEntry.includes(`const DEFAULT_MODEL = '${defaultModel}'`))

  // Defaults the card claims are the ones the bundle ships.
  const patch = read('cordis.patch.yml')
  const shown = `${clientEntry}\n${clientLocales}`
  for (const [key, pattern] of [
    ['model', /^\s*model: (\S+)$/mu],
    ['toolPolicy', /^\s*toolPolicy: (\S+)$/mu],
    ['mode', /^\s*mode: (\S+)$/mu],
    ['sessionMode', /^\s*sessionMode: (\S+)$/mu],
  ]) {
    const value = patch.match(pattern)?.[1]
    assert.ok(value !== undefined, `cordis.patch.yml no longer sets ${key}`)
    assert.ok(shown.includes(value), `card does not mention the shipped ${key} value ${value}`)
  }

  // Environment contract: every name AND its expected value, verbatim.
  const entries = [...nodeProcess.matchAll(/name: '(ZCODE_[A-Z_]+|NODE_OPTIONS)',\n\s*expected: '([^']+)'/g)]
    .map(match => ({ name: match[1], expected: match[2] }))
  assert.equal(entries.length, 5, 'ZCODE_ENV_CONTRACT changed shape; update this regex and the card together')
  for (const entry of entries) {
    assert.ok(clientEntry.includes(`name: '${entry.name}'`), `card is missing env entry ${entry.name}`)
    assert.ok(
      clientEntry.includes(`expected: '${entry.expected}'`),
      `card shows a different expected value for ${entry.name}`,
    )
  }
})

test('the card keeps a single exit with every hook above it', () => {
  // The host wraps slot entries in SlotErrorBoundary, which renders an empty
  // element when a render throws. A hook called after an early return changes
  // the hook count between renders, React throws, and the row blanks out again.
  const start = clientEntry.indexOf('const ZcodeProviderCard = ')
  const end = clientEntry.indexOf('// Keyed slot registration')
  assert.ok(start > 0 && end > start, 'could not slice the component body; update this test with the file')
  const body = clientEntry.slice(start, end)

  const returns = body.match(/\breturn\b/g) ?? []
  assert.equal(returns.length, 1, 'the card component must have exactly one exit (no early returns above hooks)')
  assert.match(body, /=> \{\n {4}const t = useTranslation\(\)/, 'the first statement of the body must be the hook call')

  const above = clientEntry.slice(0, start)
  const afterExit = body.slice(body.indexOf('return h('))
  for (const hook of ['useState(', 'useEffect(']) {
    assert.ok(above.includes(hook), `${hook} must live in a hook helper defined above the component`)
    assert.ok(!afterExit.includes(hook), `${hook} must not appear after the component's return`)
  }
  assert.ok(!body.includes('useRef('), 'the card has no refs; adding one must be a deliberate change to this test')
})
