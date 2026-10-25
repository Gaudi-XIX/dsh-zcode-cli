/**
 * Decryption of the ZCode plan credential (`zcodejwttoken`).
 *
 * The stored value has the shape `enc:v1:<iv_b64url>.<tag_b64url>.<ct_b64url>`
 * — AES-256-GCM, a 12-byte IV, a 16-byte tag, no AAD, and a key derived as
 * `sha256(ZCODE_CREDENTIAL_SECRET ?? "zcode-credential-fallback:<platform>:<homedir>:<username>")`.
 * These facts were read from the ZCode 0.17.0 CLI (`zcode.cjs`) and confirmed
 * by an end-to-end run on this host; do not guess at variations.
 *
 * Red line: the token value never enters a log, an error message, a return
 * value, or a written file. Every failure path names only *which step* failed.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { homedir as osHomedir, platform as osPlatform, userInfo } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Failure codes; each names the step, never the secret. */
export type ZcodeCredentialErrorCode =
  | 'ZCODE_CREDENTIAL_MISSING'
  | 'ZCODE_CREDENTIAL_INVALID'
  | 'ZCODE_CREDENTIAL_DECRYPT_FAILED'

export interface ZcodeCredentialErrorShape {
  readonly code: ZcodeCredentialErrorCode
  readonly message: string
}

/** Error thrown by this module; `code` is one of the three codes above. */
export class ZcodeCredentialError extends Error implements ZcodeCredentialErrorShape {
  readonly code: ZcodeCredentialErrorCode
  constructor(code: ZcodeCredentialErrorCode, message: string) {
    super(message)
    this.name = 'ZcodeCredentialError'
    this.code = code
  }
}

/** Injectable dependencies so tests never touch the real file system. */
export interface ReadZcodePlanTokenDeps {
  /** Defaults to a UTF-8 file read; tests inject whole-file text. */
  readonly readFile?: ((path: string) => string) | undefined
  /** Defaults to `ZCODE_CREDENTIAL_SECRET` with the derived fallback. */
  readonly secret?: (() => string) | undefined
  readonly platform?: string
  readonly homedir?: string
  readonly username?: string
}

const ENC_PREFIX = 'enc:v1:'

/** Default secret resolution, mirroring zcode.cjs exactly. */
export function defaultCredentialSecret(envSecret: string | undefined): string {
  const fromEnv = envSecret?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // Fall through with the placeholder, same as the CLI.
  }
  return `zcode-credential-fallback:${osPlatform()}:${osHomedir()}:${username}`
}

/**
 * Decrypt one `enc:v1:…` value with `key`. Pure.
 *
 * @throws ZcodeCredentialError `ZCODE_CREDENTIAL_INVALID` on a malformed shape,
 * `ZCODE_CREDENTIAL_DECRYPT_FAILED` on bad key/IV/tag or a failed GCM check.
 */
export function decryptEncV1(value: string, key: Uint8Array): string {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_INVALID', 'credential value is not an enc:v1: payload')
  }
  const body = value.slice(ENC_PREFIX.length)
  const parts = body.split('.')
  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_INVALID', 'credential value is not the iv.tag.ciphertext triple')
  }
  const [ivPart, tagPart, dataPart] = parts as [string, string, string]
  const iv = decodeB64Url(ivPart, 'iv')
  const tag = decodeB64Url(tagPart, 'auth tag')
  const data = decodeB64Url(dataPart, 'ciphertext')
  if (iv.length !== 12) {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'credential iv is not 12 bytes')
  }
  if (tag.length !== 16) {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'credential auth tag is not 16 bytes')
  }
  if (key.length !== 32) {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'credential key is not 32 bytes')
  }
  let decipher: ReturnType<typeof createDecipheriv> & { setAuthTag: (tag: Buffer) => void }
  try {
    decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), iv) as typeof decipher
  } catch {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'cipher init failed (bad key or iv)')
  }
  try {
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(data), decipher.final()])
    const text = plain.toString('utf8')
    // Never echo the plaintext back through an error path.
    if (text.length === 0) {
      throw new ZcodeCredentialError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'credential decrypted to an empty value')
    }
    return text
  } catch (cause) {
    if (cause instanceof ZcodeCredentialError) throw cause
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'GCM authentication failed (wrong key or tampered ciphertext)')
  }
}

function decodeB64Url(part: string, what: string): Buffer {
  const buf = Buffer.from(part, 'base64url')
  if (buf.length === 0) {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_INVALID', `credential ${what} is not valid base64url`)
  }
  return buf
}

function credentialKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/**
 * Read and decrypt the plan token for `dataBaseDir` (= `ZCODE_DATA_BASE_DIR`).
 *
 * @returns the JWT (a 204-character string on this host; the length is a
 * sanity hint, not a validation gate, so a future token length does not break
 * the channel).
 * @throws ZcodeCredentialError with one of the three codes; the message never
 * contains any credential material.
 */
export function readZcodePlanToken(dataBaseDir: string, deps: ReadZcodePlanTokenDeps = {}): string {
  const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const path = join(dataBaseDir, '.zcode', 'v2', 'credentials.json')
  let raw: string
  try {
    raw = readFile(path)
  } catch {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_MISSING', `cannot read ZCode credentials file at ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_INVALID', 'credentials file is not valid JSON')
  }
  const token = (parsed as Record<string, unknown> | null)?.['zcodejwttoken']
  if (typeof token !== 'string' || token.length === 0) {
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_INVALID', 'credentials file has no zcodejwttoken entry')
  }
  const secret = deps.secret ?? ((): string => defaultCredentialSecret(process.env['ZCODE_CREDENTIAL_SECRET']))
  const key = credentialKey(secret())
  const plain = decryptEncV1(token, new Uint8Array(key))
  if (plain.length === 0) {
    // Report only the emptiness, never the value.
    throw new ZcodeCredentialError('ZCODE_CREDENTIAL_INVALID', 'credential decrypted to an empty token')
  }
  return plain
}
