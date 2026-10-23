// AC7 (environment contract): every missing or blank entry fails closed, names
// the variable, and states the value it must carry. The checks run against a
// plain object snapshot, so the real `process.env` is never mutated.

import assert from 'node:assert/strict'
import test from 'node:test'

import { isZcodeError } from '../lib/provider/error-codes.js'
import {
  MIN_NODE_MAJOR,
  ZCODE_ENV_CONTRACT,
  assertEnvContract,
  missingEnvKeys,
} from '../lib/zcode/process.js'

/** A complete environment, built from the contract's own expectations. */
function completeEnv() {
  const env = {}
  for (const entry of ZCODE_ENV_CONTRACT) env[entry.name] = entry.expected
  return env
}

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

  assert.deepEqual(resolved, env)
  assert.deepEqual(missingEnvKeys(env), [])
})

for (const entry of ZCODE_ENV_CONTRACT) {
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

test('AC7: restoring a deleted entry clears the failure', () => {
  const snapshot = completeEnv()
  const env = { ...snapshot }
  delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE

  assert.throws(() => assertEnvContract(env), error => error.code === 'ZCODE_ENV_MISSING')

  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = snapshot.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  assert.doesNotThrow(() => assertEnvContract(env))
  assert.deepEqual(assertEnvContract(env), snapshot)
})

test('AC7: every missing entry is reported at once, not one per attempt', () => {
  assert.throws(
    () => assertEnvContract({}),
    error => {
      assert.equal(error.code, 'ZCODE_ENV_MISSING')
      for (const entry of ZCODE_ENV_CONTRACT) {
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
