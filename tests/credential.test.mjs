/**
 * Offline tests for `src/zcode/credential.ts` — fixed AES vectors, the three
 * failure codes, secret-source selection, and the credential red line: the
 * plaintext token never appears in any error message or thrown object.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

import {
  defaultCredentialSecret,
  decryptEncV1,
  readZcodePlanToken,
  ZcodeCredentialError,
} from '../lib/zcode/credential.js'

/** A fake but realistic 204-char JWT; searchable so leak assertions can grep. */
const FAKE_JWT = ('eyJFAKE.' + 'x'.repeat(180) + '.sig').slice(0, 204).padEnd(204, '0')
const SECRET_TEXT = 'unit-test-secret'
const KEY = createHash('sha256').update(SECRET_TEXT).digest()

/** Encrypt a plaintext into the exact `enc:v1:` wire shape. */
function encryptFixture(plain, key, iv = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`
}

test('decryptEncV1 round-trips a fixed vector', () => {
  const iv = Buffer.from('0123456789abcdef012345', 'utf8').subarray(0, 12)
  const value = encryptFixture(FAKE_JWT, KEY, iv)
  assert.equal(decryptEncV1(value, new Uint8Array(KEY)), FAKE_JWT)
})

test('decryptEncV1 rejects malformed shapes with ZCODE_CREDENTIAL_INVALID', () => {
  assert.throws(() => decryptEncV1('plain-jwt', new Uint8Array(KEY)), (err) => err instanceof ZcodeCredentialError && err.code === 'ZCODE_CREDENTIAL_INVALID')
  assert.throws(() => decryptEncV1('enc:v1:onlyone', new Uint8Array(KEY)), (err) => err instanceof ZcodeCredentialError && err.code === 'ZCODE_CREDENTIAL_INVALID')
  assert.throws(() => decryptEncV1(`enc:v1:${'!!'}.${'!!'}.${'!!'}`, new Uint8Array(KEY)), (err) => err instanceof ZcodeCredentialError && err.code === 'ZCODE_CREDENTIAL_INVALID')
})

test('decryptEncV1 rejects wrong key / bad IV / bad tag with DECRYPT_FAILED', () => {
  const good = encryptFixture(FAKE_JWT, KEY)
  const otherKey = createHash('sha256').update('another-secret').digest()
  assert.throws(() => decryptEncV1(good, new Uint8Array(otherKey)), (err) => err.code === 'ZCODE_CREDENTIAL_DECRYPT_FAILED')

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(FAKE_JWT, 'utf8')), cipher.final()])
  const badIv = `enc:v1:${randomBytes(11).toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`
  assert.throws(() => decryptEncV1(badIv, new Uint8Array(KEY)), (err) => err.code === 'ZCODE_CREDENTIAL_DECRYPT_FAILED')

  const badTag = `enc:v1:${iv.toString('base64url')}.${randomBytes(16).toString('base64url')}.${ct.toString('base64url')}`
  assert.throws(() => decryptEncV1(badTag, new Uint8Array(KEY)), (err) => err.code === 'ZCODE_CREDENTIAL_DECRYPT_FAILED')

  const shortTag = `enc:v1:${iv.toString('base64url')}.${randomBytes(15).toString('base64url')}.${ct.toString('base64url')}`
  assert.throws(() => decryptEncV1(shortTag, new Uint8Array(KEY)), (err) => err.code === 'ZCODE_CREDENTIAL_DECRYPT_FAILED')

  const shortKey = randomBytes(31)
  assert.throws(() => decryptEncV1(good, new Uint8Array(shortKey)), (err) => err.code === 'ZCODE_CREDENTIAL_DECRYPT_FAILED')
})

test('readZcodePlanToken: missing file → ZCODE_CREDENTIAL_MISSING', () => {
  assert.throws(
    () => readZcodePlanToken('D:/no/such/dir', { readFile: () => { throw new Error('ENOENT') } }),
    (err) => err.code === 'ZCODE_CREDENTIAL_MISSING',
  )
})

test('readZcodePlanToken: invalid JSON / missing key / wrong shape → ZCODE_CREDENTIAL_INVALID', () => {
  assert.throws(
    () => readZcodePlanToken('D:/x', { readFile: () => 'not json', secret: () => SECRET_TEXT }),
    (err) => err.code === 'ZCODE_CREDENTIAL_INVALID',
  )
  assert.throws(
    () => readZcodePlanToken('D:/x', { readFile: () => JSON.stringify({}), secret: () => SECRET_TEXT }),
    (err) => err.code === 'ZCODE_CREDENTIAL_INVALID',
  )
  // An empty plaintext is still rejected (length gate relaxed: tokens rotate).
  const empty = encryptFixture('', KEY)
  assert.throws(
    () => readZcodePlanToken('D:/x', { readFile: () => JSON.stringify({ zcodejwttoken: empty }), secret: () => SECRET_TEXT }),
    (err) => err.code === 'ZCODE_CREDENTIAL_INVALID',
  )
})

test('readZcodePlanToken: happy path decrypts to the 204-char JWT', () => {
  const file = JSON.stringify({ zcodejwttoken: encryptFixture(FAKE_JWT, KEY) })
  const token = readZcodePlanToken('D:/x', { readFile: () => file, secret: () => SECRET_TEXT })
  assert.equal(token, FAKE_JWT)
})

test('secret source: ZCODE_CREDENTIAL_SECRET wins, fallback derived otherwise', () => {
  assert.equal(defaultCredentialSecret('  env-secret  '), 'env-secret')
  assert.equal(defaultCredentialSecret(''), defaultCredentialSecret(undefined))
  // The fallback must be the exact documented string with this host's facts.
  const fallback = defaultCredentialSecret(undefined)
  assert.match(fallback, /^zcode-credential-fallback:/)
  // A token encrypted under the fallback decrypts when no env override exists.
  const fallbackKey = createHash('sha256').update(fallback).digest()
  const file = JSON.stringify({ zcodejwttoken: encryptFixture(FAKE_JWT, fallbackKey) })
  const token = readZcodePlanToken('D:/x', { readFile: () => file, secret: undefined })
  assert.equal(token, FAKE_JWT)
})

test('red line: no error path leaks the plaintext token', () => {
  const badToken = 'enc:v1:' + 'AAA.AAA.AAA'
  const cases = []
  try { readZcodePlanToken('D:/x', { readFile: () => { throw new Error('boom') }, secret: () => SECRET_TEXT }) } catch (err) { cases.push(err) }
  try { readZcodePlanToken('D:/x', { readFile: () => '}', secret: () => SECRET_TEXT }) } catch (err) { cases.push(err) }
  try { readZcodePlanToken('D:/x', { readFile: () => JSON.stringify({ other: 1 }), secret: () => SECRET_TEXT }) } catch (err) { cases.push(err) }
  try { readZcodePlanToken('D:/x', { readFile: () => JSON.stringify({ zcodejwttoken: badToken }), secret: () => SECRET_TEXT }) } catch (err) { cases.push(err) }
  try { readZcodePlanToken('D:/x', { readFile: () => JSON.stringify({ zcodejwttoken: encryptFixture('', KEY) }), secret: () => SECRET_TEXT }) } catch (err) { cases.push(err) }
  assert.ok(cases.length >= 5)
  for (const err of cases) {
    const text = `${err.message} ${String(err.code)} ${JSON.stringify(err)} ${err.stack ?? ''}`
    assert.ok(!text.includes(FAKE_JWT), 'plaintext token leaked in an error')
    assert.ok(!text.includes('eyJ'), 'JWT fragment leaked in an error')
  }
})
