// AC9 + B7 (doctor): the report aggregates eight fixed checks, fails closed on
// a host that cannot run ZCode, and never states plan state. Every input is
// injected (environment, paths, Node version, file reader, last quota
// observation, clock), so this file never reads the machine's real ZCode
// installation and never spawns the CLI.

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_MODELS, DEFAULT_MODEL } from '../lib/provider/config.js'
import { DOCTOR_CHECK_IDS, runDoctor } from '../lib/doctor.js'
import { ZCODE_ENV_CONTRACT } from '../lib/zcode/process.js'

/** A path that does not exist on any host: the temp dir, with a unique name. */
const ABSENT = join(tmpdir(), `dsh-zcode-doctor-absent-${process.pid}`)
/** A path that certainly exists and is a file: this test file itself. */
const EXISTING_FILE = fileURLToPath(import.meta.url)

/** A provider config good enough to parse, shaped like the real pair. */
const GOOD_CONFIG = JSON.stringify({
  defaultModelSelection: 'GLM-5.3-Flash',
  personalModelIds: ['GLM-5.3-Flash', 'GLM-5.3'],
})

function contractEnv(overrides = {}) {
  const env = {}
  for (const entry of ZCODE_ENV_CONTRACT) env[entry.name] = entry.expected
  return { ...env, ...overrides }
}

/** Options of a host on which every check should pass. */
function healthyHost(overrides = {}) {
  return {
    env: contractEnv(),
    nodeVersion: '24.15.0',
    nodePath: process.execPath,
    zcodeCjsPath: EXISTING_FILE,
    builtinProviderConfigPath: EXISTING_FILE,
    personalProviderConfigPath: EXISTING_FILE,
    readTextFile: () => GOOD_CONFIG,
    lastQuota: null,
    now: () => new Date('2026-10-24T02:40:00.000Z'),
    ...overrides,
  }
}

/** The verdict of one check id. */
function checkOf(report, id) {
  const found = report.checks.find(item => item.id === id)
  assert.ok(found, `report has no ${id} check`)
  return found
}

test('AC9: a healthy host passes every check and reports quotaUsed false', async () => {
  const report = await runDoctor(healthyHost())

  assert.deepEqual(report.checks.map(item => item.id), [...DOCTOR_CHECK_IDS])
  assert.equal(report.checks.length, 8)
  assert.equal(report.status, 'pass')
  assert.equal(report.ok, true)
  assert.equal(report.quotaUsed, false)
  assert.equal(report.lastQuota, null)
  assert.equal(report.checkedAt, '2026-10-24T02:40:00.000Z')
  for (const item of report.checks) {
    assert.equal(item.status, 'pass', `${item.id}: ${item.detail}`)
  }
})

test('AC9: the report never states or implies plan state', async () => {
  const report = await runDoctor(healthyHost())
  const serialised = JSON.stringify(report)

  // AC9: zero matches for any spelling of the field the report must not carry.
  assert.equal((serialised.match(/entitled|entitlement/gi) ?? []).length, 0)
  assert.equal(report.quotaUsed, false)
  // The only plan-shaped datum is a recollection of a past rejection.
  const lastQuota = checkOf(report, 'last-quota')
  assert.equal(lastQuota.status, 'pass')
  assert.match(lastQuota.detail, /not probed locally/)
})

test('AC9: a missing environment entry fails the env-contract check', async () => {
  const env = contractEnv()
  delete env.NODE_OPTIONS
  const report = await runDoctor(healthyHost({ env }))

  const verdict = checkOf(report, 'env-contract')
  assert.equal(verdict.status, 'fail')
  assert.ok(verdict.detail.includes('NODE_OPTIONS'), verdict.detail)
  assert.equal(report.status, 'fail')
  assert.equal(report.ok, false)
  assert.equal(report.quotaUsed, false)
})

test('AC9: an environment that differs from the recorded install warns, not fails', async () => {
  const report = await runDoctor(healthyHost({ env: contractEnv({ ZCODE_HOME: 'D:\\zcode\\home' }) }))

  const verdict = checkOf(report, 'env-contract')
  assert.equal(verdict.status, 'warn')
  assert.ok(verdict.detail.includes('ZCODE_HOME'), verdict.detail)
  assert.equal(report.status, 'warn')
  // A warning is drift, not breakage: the report stays ok.
  assert.equal(report.ok, true)
})

test('AC9: Node below the floor fails with the required major version', async () => {
  const report = await runDoctor(healthyHost({ nodeVersion: '20.11.0' }))

  const verdict = checkOf(report, 'node-version')
  assert.equal(verdict.status, 'fail')
  assert.ok(verdict.detail.includes('20'), verdict.detail)
  assert.ok(verdict.detail.includes('22'), verdict.detail)
  assert.equal(report.node.major, 20)
  assert.equal(report.node.supported, false)
  assert.equal(report.ok, false)
})

test('AC9: a missing Node executable fails its own check', async () => {
  const report = await runDoctor(healthyHost({ nodePath: ABSENT }))

  const verdict = checkOf(report, 'node-executable')
  assert.equal(verdict.status, 'fail')
  assert.ok(verdict.detail.includes(ABSENT), verdict.detail)
  assert.equal(report.nodeExecutable.exists, false)
})

test('AC9: a missing CLI entry fails instead of being inferred', async () => {
  const report = await runDoctor(healthyHost({ zcodeCjsPath: ABSENT }))

  const verdict = checkOf(report, 'cli-entry')
  assert.equal(verdict.status, 'fail')
  assert.ok(verdict.detail.includes(ABSENT), verdict.detail)
  assert.equal(report.cli.exists, false)
})

test('AC9: missing provider configs fail both config checks', async () => {
  const report = await runDoctor(healthyHost({
    builtinProviderConfigPath: ABSENT,
    personalProviderConfigPath: ABSENT,
  }))

  assert.equal(checkOf(report, 'builtin-config').status, 'fail')
  assert.equal(checkOf(report, 'personal-config').status, 'fail')
  assert.equal(report.configs.builtin.exists, false)
  assert.equal(report.configs.personal.exists, false)
})

test('AC9: an unreadable provider config fails as unreadable, not as missing', async () => {
  const report = await runDoctor(healthyHost({
    readTextFile: () => {
      throw new Error('EACCES: fake permission denied')
    },
  }))

  const verdict = checkOf(report, 'personal-config')
  assert.equal(verdict.status, 'fail')
  assert.ok(verdict.detail.includes('unreadable'), verdict.detail)
  assert.ok(verdict.detail.includes('EACCES'), verdict.detail)
  assert.equal(report.configs.personal.exists, true)
  assert.equal(report.configs.personal.readable, false)
})

test('AC9: a provider config that is not JSON fails as unparseable', async () => {
  const report = await runDoctor(healthyHost({ readTextFile: () => 'this is not json' }))

  const verdict = checkOf(report, 'builtin-config')
  assert.equal(verdict.status, 'fail')
  assert.ok(verdict.detail.includes('not valid JSON'), verdict.detail)
  assert.equal(report.configs.builtin.parsed, false)
})

test('AC9: the model catalog fails when empty or when the default is not listed', async () => {
  const empty = await runDoctor(healthyHost({ models: [] }))
  assert.equal(checkOf(empty, 'model-catalog').status, 'fail')
  assert.ok(checkOf(empty, 'model-catalog').detail.includes('No model'), checkOf(empty, 'model-catalog').detail)

  const unknownDefault = await runDoctor(healthyHost({ defaultModel: 'GPT-9' }))
  assert.equal(checkOf(unknownDefault, 'model-catalog').status, 'fail')
  assert.ok(checkOf(unknownDefault, 'model-catalog').detail.includes('GPT-9'))
})

test('AC9: an id outside the static catalog warns', async () => {
  const report = await runDoctor(healthyHost({
    models: [...DEFAULT_MODELS, { id: 'GLM-9' }],
    defaultModel: DEFAULT_MODEL,
  }))

  const verdict = checkOf(report, 'model-catalog')
  assert.equal(verdict.status, 'warn')
  assert.ok(verdict.detail.includes('GLM-9'), verdict.detail)
  assert.equal(report.ok, true)
})

test('AC9: a recorded quota rejection is reported, and never becomes a failure', async () => {
  const report = await runDoctor(healthyHost({
    lastQuota: { observedAt: '2026-10-24T01:07:00.000Z', providerCode: '1309', requestId: 'req_1' },
  }))

  const verdict = checkOf(report, 'last-quota')
  assert.equal(verdict.status, 'warn')
  assert.ok(verdict.detail.includes('1309'), verdict.detail)
  assert.ok(verdict.detail.includes('2026-10-24T01:07:00.000Z'), verdict.detail)
  assert.equal(report.status, 'warn')
  assert.equal(report.ok, true)
  assert.equal(report.quotaUsed, false)
  assert.equal(report.lastQuota?.providerCode, '1309')
})

test('AC9: config paths fall back to the injected environment when not passed as options', async () => {
  const env = contractEnv({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: ABSENT,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: EXISTING_FILE,
  })
  const options = healthyHost({ env })
  delete options.builtinProviderConfigPath
  delete options.personalProviderConfigPath

  const report = await runDoctor(options)

  assert.equal(report.paths.builtinProviderConfigPath, ABSENT)
  assert.equal(report.paths.personalProviderConfigPath, EXISTING_FILE)
  assert.equal(checkOf(report, 'builtin-config').status, 'fail')
  assert.equal(checkOf(report, 'personal-config').status, 'pass')
})

test('AC9: the report carries no prompt, response, or credential material', async () => {
  const report = await runDoctor(healthyHost({
    lastQuota: { observedAt: '2026-10-24T01:07:00.000Z', providerCode: '1309', requestId: 'req_1' },
  }))
  const serialised = JSON.stringify(report)

  // B7: the report is operator-facing metadata only.
  assert.equal(serialised.includes('personalModelIds'), false)
  assert.equal(serialised.includes('Authorization'), false)
  assert.equal(serialised.includes(GOOD_CONFIG), false)
})
