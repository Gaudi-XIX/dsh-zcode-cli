// AC7 (environment contract): every missing or blank path entry fails closed,
// names the variable, and states the value it must carry. `NODE_OPTIONS` is the
// one entry the provider supplies itself, and a host value of it must pass a
// value-level allowlist (loader/eval switches are code execution). The child
// environment is also built from a closed allowlist, so a host secret never
// reaches ZCode. The checks run against plain object snapshots, so the real
// `process.env` is never mutated.

import assert from 'node:assert/strict'
import test from 'node:test'

import { isZcodeError } from '../lib/provider/error-codes.js'
import {
  MIN_NODE_MAJOR,
  NODE_OPTIONS_REQUIRED,
  ZCODE_ENV_ALLOWLIST,
  ZCODE_ENV_CONTRACT,
  assertEnvContract,
  buildChildEnv,
  missingEnvKeys,
  resolveNodeOptions,
} from '../lib/zcode/process.js'

/** A complete environment, built from the contract's own expectations. */
function completeEnv() {
  const env = {}
  for (const entry of ZCODE_ENV_CONTRACT) env[entry.name] = entry.expected
  return env
}

/** The contract entries a host must actually provide. */
const REQUIRED_ENTRIES = ZCODE_ENV_CONTRACT.filter(entry => entry.name !== 'NODE_OPTIONS')

test('AC7: the contract is exactly the five documented entries', () => {
  assert.equal(ZCODE_ENV_CONTRACT.length, 5)
  assert.deepEqual(ZCODE_ENV_CONTRACT.map(entry => entry.name), [
    'ZCODE_HOME',
    'ZCODE_DATA_BASE_DIR',
    'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
    'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
    'NODE_OPTIONS',
  ])
  for (const entry of ZCODE_ENV_CONTRACT) {
    assert.equal(typeof entry.expected, 'string')
    assert.ok(entry.expected.length > 0, `${entry.name} has no expected value`)
    assert.equal(typeof entry.note, 'string')
  }
  assert.equal(MIN_NODE_MAJOR, 22)
})

test('AC7: a complete environment resolves without throwing', () => {
  const env = completeEnv()
  const resolved = assertEnvContract(env)

  assert.deepEqual(missingEnvKeys(env), [])
  for (const entry of REQUIRED_ENTRIES) assert.equal(resolved[entry.name], env[entry.name])
  // The host value is checked, then replaced by the canonical flag pair.
  assert.equal(resolved['NODE_OPTIONS'], NODE_OPTIONS_REQUIRED.join(' '))
})

for (const entry of REQUIRED_ENTRIES) {
  test(`AC7: deleting ${entry.name} fails closed with the variable and its expected value`, () => {
    const env = completeEnv()
    delete env[entry.name]

    assert.deepEqual(missingEnvKeys(env), [entry.name])

    assert.throws(
      () => assertEnvContract(env),
      error => {
        assert.equal(isZcodeError(error), true, 'the failure must be a ZcodeError')
        assert.equal(error.code, 'ZCODE_ENV_MISSING')
        // AC7: the message must name the entry and the path/flag it expects, so
        // an operator can repair the host from the log line alone.
        assert.ok(error.message.includes(entry.name), `message lost ${entry.name}: ${error.message}`)
        assert.ok(
          error.message.includes(entry.expected),
          `message lost the expected value of ${entry.name}: ${error.message}`,
        )
        assert.ok(error.stderrTail?.includes(entry.name), 'stderrTail must list the missing entry')
        return true
      },
    )
  })

  test(`AC7: blanking ${entry.name} is the same failure as deleting it`, () => {
    const env = completeEnv()
    env[entry.name] = '   '

    assert.deepEqual(missingEnvKeys(env), [entry.name])
    assert.throws(() => assertEnvContract(env), error => error.code === 'ZCODE_ENV_MISSING')
  })
}

test('AC7: NODE_OPTIONS is self-supplied, so its absence is not a failure', () => {
  const env = completeEnv()
  delete env.NODE_OPTIONS

  assert.deepEqual(missingEnvKeys(env), [])
  assert.equal(assertEnvContract(env)['NODE_OPTIONS'], NODE_OPTIONS_REQUIRED.join(' '))

  env.NODE_OPTIONS = '   '
  assert.equal(assertEnvContract(env)['NODE_OPTIONS'], NODE_OPTIONS_REQUIRED.join(' '))
})

test('AC7: NODE_OPTIONS passes only the documented DNS flags', () => {
  assert.equal(resolveNodeOptions(undefined), NODE_OPTIONS_REQUIRED.join(' '))
  // Order is preserved; duplicates collapse onto the required pair.
  assert.equal(
    resolveNodeOptions('--dns-result-order=ipv4first'),
    '--dns-result-order=ipv4first --no-network-family-autoselection',
  )
})

for (const value of ['--require ./evil.js', '--require=./evil.js', '-r ./evil.js', '--import ./evil.mjs', '--loader ./evil.mjs', '-e "process.exit(0)"']) {
  test(`AC7: NODE_OPTIONS ${JSON.stringify(value)} is refused (code execution channel)`, () => {
    assert.throws(
      () => resolveNodeOptions(value),
      error => {
        assert.equal(isZcodeError(error), true)
        assert.equal(error.code, 'ZCODE_ENV_MISSING')
        assert.match(error.message, /NODE_OPTIONS carries an unsupported flag/)
        assert.match(error.message, /--dns-result-order=ipv4first/)
        return true
      },
    )
    // And the contract check surfaces the same failure, before any spawn.
    assert.throws(
      () => assertEnvContract({ ...completeEnv(), NODE_OPTIONS: value }),
      error => error.code === 'ZCODE_ENV_MISSING',
    )
  })
}

test('AC7: the child environment is the allowlist plus the contract, never the host env', () => {
  const contract = assertEnvContract(completeEnv())
  const child = buildChildEnv({
    source: {
      ...completeEnv(),
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      SECRET_CANARY: '1',
      AWS_SECRET_ACCESS_KEY: 'nope',
      passEnvAllowed: 'kept',
    },
    contract,
    passEnv: ['passEnvAllowed', 'bad name', 'MISSING_ONE'],
  })

  assert.equal(child['SECRET_CANARY'], undefined)
  assert.equal(child['AWS_SECRET_ACCESS_KEY'], undefined)
  assert.equal(child['PATH'], '/usr/bin')
  assert.equal(child['SystemRoot'], 'C:\\Windows')
  assert.equal(child['passEnvAllowed'], 'kept')
  assert.equal(child['MISSING_ONE'], undefined, 'an unset passEnv name contributes nothing')
  for (const name of Object.keys(contract)) assert.equal(child[name], contract[name])
  for (const name of Object.keys(child)) {
    assert.ok(
      Object.hasOwn(contract, name) || ZCODE_ENV_ALLOWLIST.includes(name) || name === 'passEnvAllowed',
      `unexpected child variable ${name}`,
    )
  }
})

test('AC7: a fake request.env is the only source the child sees', () => {
  const contract = assertEnvContract(completeEnv())
  const child = buildChildEnv({
    // No PATH at all in the fake source: the real process.env must not leak in.
    source: { ...completeEnv(), SECRET_CANARY: '1' },
    contract,
  })

  assert.equal(child['SECRET_CANARY'], undefined)
  assert.equal(child['PATH'], undefined, 'the child env must not be seeded from process.env')
})

test('AC7: restoring a deleted entry clears the failure', () => {
  const snapshot = completeEnv()
  const env = { ...snapshot }
  delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE

  assert.throws(() => assertEnvContract(env), error => error.code === 'ZCODE_ENV_MISSING')

  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = snapshot.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  assert.doesNotThrow(() => assertEnvContract(env))
  assert.deepEqual(assertEnvContract(env), { ...snapshot, NODE_OPTIONS: NODE_OPTIONS_REQUIRED.join(' ') })
})

test('AC7: every missing entry is reported at once, not one per attempt', () => {
  assert.throws(
    () => assertEnvContract({}),
    error => {
      assert.equal(error.code, 'ZCODE_ENV_MISSING')
      for (const entry of REQUIRED_ENTRIES) {
        assert.ok(error.message.includes(entry.name), `message lost ${entry.name}: ${error.message}`)
      }
      return true
    },
  )
})

test('AC7: the check does not mutate the environment it inspects', () => {
  const snapshot = completeEnv()
  const env = { ...snapshot }
  const before = JSON.stringify(env)

  assertEnvContract(env)
  assert.equal(JSON.stringify(env), before)
  assert.deepEqual(env, snapshot)
})
