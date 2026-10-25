/**
 * Offline tests for `src/zcode/account-config.ts` — inline builtin text, no
 * file system, no network.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  buildZcodeAccountConfig,
  DEFAULT_START_PLAN_CONNECTION_KEY,
  readRuntimeBuiltinRevisionTag,
} from '../lib/zcode/account-config.js'

/** An empty log dir (no runtime tag available). */
const EMPTY_DIR = mkdtempSync(join(tmpdir(), 'zcode-acct-empty-'))
/** A log dir whose newest file carries a runtime delivery line. */
const LOG_DIR_WITH_TAG = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-acct-log-'))
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, '2026-10-26.log'),
    'noise without a tag\n'
    + '... receivedRevision":"account:[\\"zcode-builtin:33:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\",'
    + 'noise after\n', 'utf8')
  return dir
})()

/** A reduced builtin config: all ten account providers, the real ids. */
const ACCOUNT_IDS = [
  ['account:zai-individual-coding-plan', 'individual-coding-plan', 'zai', 'https://api.z.ai/api/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['account:zai-team-coding-plan', 'team-coding-plan', 'zai', 'https://api.z.ai/api/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['account:zai-start-plan', 'start-plan', 'zai', 'https://zcode.z.ai/api/v1/zcode-plan/anthropic', ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']],
  ['account:bigmodel-individual-coding-plan', 'individual-coding-plan', 'bigmodel', 'https://open.bigmodel.cn/api/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['account:bigmodel-team-coding-plan', 'team-coding-plan', 'bigmodel', 'https://open.bigmodel.cn/api/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['account:bigmodel-start-plan', 'start-plan', 'bigmodel', 'https://zcode.z.ai/api/v1/zcode-plan/anthropic', ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']],
  ['account:zai-offpeak-idle-plan', 'off-peak', 'zai', 'https://zcode.z.ai/api/v1/off-peak/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['account:bigmodel-offpeak-idle-plan', 'off-peak', 'bigmodel', 'https://zcode.z.ai/api/v1/off-peak/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['account:zai-highspeed-card', 'highspeed', 'zai', 'https://zcode.z.ai/api/v1/highspeed/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['account:bigmodel-highspeed-card', 'highspeed', 'bigmodel', 'https://zcode.z.ai/api/v1/highspeed/anthropic', ['GLM-5.3', 'GLM-5.3-Flash']],
]

function builtinText(revision = '33', extraProvider) {
  const rules = ACCOUNT_IDS.map(([providerId, mode, accountType, baseUrl, models]) => ({
    providerId,
    providerName: providerId,
    config: {
      group: 'g',
      builtinModelIds: models,
      access: { type: 'zhipu-account', mode, accountType },
      api: { type: 'anthropic-messages', baseUrl },
      logo: { type: 'builtin', key: 'zai' },
    },
  }))
  if (extraProvider !== undefined) rules.push(extraProvider)
  return JSON.stringify({ schemaVersion: 1, revision, config: { providerConfigRules: { templateRules: [], providerRules: rules }, modelConfigRules: {} } })
}

const BASE = { builtinPath: 'F:/fake/zcode-builtin.json', accountType: 'bigmodel', mode: 'start-plan', readFile: () => builtinText() }
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

test('builds ten account providers with the target enabled', () => {
  const config = buildZcodeAccountConfig(BASE)
  assert.equal(Object.keys(config.updateParams.providers).length, 10)
  assert.equal(Object.keys(config.updateParams.states).length, 10)
  assert.equal(config.providerId, 'account:bigmodel-start-plan')
  const target = config.updateParams.providers['account:bigmodel-start-plan']
  assert.deepEqual(target.access, { type: 'zhipu-account', entitled: true })
  assert.deepEqual([...target.builtinModelIds], ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'])
  const targetState = config.updateParams.states['account:bigmodel-start-plan']
  assert.equal(targetState.availability, 'available')
  assert.equal(targetState.entitled, true)
  assert.equal(targetState.current, true)
  // Everyone else is off.
  for (const [id, provider] of Object.entries(config.updateParams.providers)) {
    if (id === 'account:bigmodel-start-plan') continue
    assert.equal(provider.access.entitled, false, id)
    assert.equal(config.updateParams.states[id].current, false, id)
  }
  // Ten entries carried through, with modes and baseUrls.
  assert.equal(config.entries.length, 10)
  const zaiStart = config.entries.find(entry => entry.providerId === 'account:zai-start-plan')
  assert.equal(zaiStart.mode, 'start-plan')
  assert.equal(zaiStart.accountType, 'zai')
  assert.equal(zaiStart.baseUrl, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic')
})

test('basedOnZCodeBuiltinRevision falls back to the path hash without runtime logs', async () => {
  const config = buildZcodeAccountConfig({ ...BASE, runtimeLogDir: EMPTY_DIR })
  const match = /^zcode-builtin:33:([0-9a-f]{64})$/.exec(config.basedOnZCodeBuiltinRevision)
  assert.ok(match, config.basedOnZCodeBuiltinRevision)
  // Same hash the CLI computes: sha256 over the resolved absolute path.
  assert.equal(match[1], sha256(resolve('F:/fake/zcode-builtin.json')))
  assert.equal(config.updateParams.basedOnZCodeBuiltinRevision, config.basedOnZCodeBuiltinRevision)
})

test('the runtime-reported tag wins over the path hash and lands in the canonical revision', () => {
  const config = buildZcodeAccountConfig({ ...BASE, runtimeLogDir: LOG_DIR_WITH_TAG })
  assert.equal(config.basedOnZCodeBuiltinRevision, 'zcode-builtin:33:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  // canonical revision embeds [basedOn, providers array, states]
  const parsed = JSON.parse(config.updateParams.revision.slice('account:'.length))
  assert.equal(parsed[0], 'zcode-builtin:33:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  assert.equal(parsed[1].length, 10)
  assert.ok(parsed[1].every(entry => typeof entry.providerId === 'string' && typeof entry.config === 'object'))
  assert.equal(parsed[2]['account:bigmodel-start-plan'].connectionKey, DEFAULT_START_PLAN_CONNECTION_KEY)
})

test('readRuntimeBuiltinRevisionTag reads the newest delivery line and tolerates junk dirs', () => {
  assert.equal(
    readRuntimeBuiltinRevisionTag(LOG_DIR_WITH_TAG),
    'zcode-builtin:33:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  )
  assert.equal(readRuntimeBuiltinRevisionTag(EMPTY_DIR), undefined)
  assert.equal(readRuntimeBuiltinRevisionTag('F:/definitely/not/a/dir'), undefined)
})

test('revision differs when revisionSeed differs', () => {
  const a = buildZcodeAccountConfig({ ...BASE, revisionSeed: 'account:1000' })
  const b = buildZcodeAccountConfig({ ...BASE, revisionSeed: 'account:1001' })
  assert.notEqual(a.updateParams.revision, b.updateParams.revision)
  assert.equal(a.updateParams.revision, 'account:1000')
})

test('throws when the target mode is not in the table', () => {
  assert.throws(
    () => buildZcodeAccountConfig({ ...BASE, mode: 'nonexistent-plan' }),
    (err) => err.message.includes('ZCODE_ACCOUNT_CONFIG_INVALID') && err.message.includes('nonexistent-plan'),
  )
})

test('throws on unreadable / non-JSON / schema-less builtin text', () => {
  assert.throws(() => buildZcodeAccountConfig({ ...BASE, readFile: () => { throw new Error('ENOENT') } }), (err) => err.message.includes('cannot read'))
  assert.throws(() => buildZcodeAccountConfig({ ...BASE, readFile: () => 'nope' }), (err) => err.message.includes('not valid JSON'))
  assert.throws(
    () => buildZcodeAccountConfig({ ...BASE, readFile: () => JSON.stringify({ revision: '33' }) }),
    (err) => err.message.includes('ZCODE_ACCOUNT_CONFIG_INVALID'),
  )
})

test('minimal single-provider payload also builds (fixture shape from the brief)', () => {
  const text = JSON.stringify({
    revision: '33',
    config: { providerConfigRules: { providerRules: [{
      providerId: 'account:bigmodel-start-plan',
      config: {
        access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'bigmodel' },
        api: { baseUrl: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
        builtinModelIds: ['GLM-5.3-Flash'],
      },
    }] } },
  })
  const config = buildZcodeAccountConfig({ ...BASE, readFile: () => text })
  assert.equal(config.providerId, 'account:bigmodel-start-plan')
  assert.deepEqual(config.updateParams.providers['account:bigmodel-start-plan'].access, { type: 'zhipu-account', entitled: true })
})
