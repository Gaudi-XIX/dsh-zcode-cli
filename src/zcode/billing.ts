/**
 * Read-only view of the ZCode plan and quota service.
 *
 * The panel on the Models page has to answer "how much quota is left and when
 * does it expire" without spending a model turn. The ZCode CLI writes an
 * AES-256-GCM encrypted JWT into its credential store at sign-in and the plan
 * endpoint accepts that JWT directly, so this module does three things and
 * nothing else: locate the store, decrypt the token, GET the billing snapshot.
 *
 * Boundaries that matter:
 * - The token, its ciphertext and every decryption intermediate stay inside
 *   this module. Error messages carry a reason, never a secret.
 * - The payload is validated at runtime. A surprising shape raises
 *   ZCODE_BILLING_PARSE instead of being coerced into numbers nobody sent.
 * - Reads are cached in-process for {@link ZCODE_BILLING_CACHE_TTL_MS}; the
 *   cache is only written on success, so a failed read never looks fresh.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  ZcodeError,
  sanitizeSecrets,
  type ZcodeErrorCode,
  type ZcodeErrorOptions,
} from '../provider/error-codes.js'

/** Documented billing endpoint of the ZCode plan service. */
export const ZCODE_BILLING_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance'

/** How long one successful read is reused by {@link createBillingReader}. */
export const ZCODE_BILLING_CACHE_TTL_MS = 30_000

/** Prefix the credential store puts in front of an encrypted value. */
const CREDENTIAL_PREFIX = 'enc:v1:'

/** AES-256-GCM layout used by the ZCode credential store: 16-byte IV, 16-byte tag. */
const GCM_IV_BYTES = 16
const GCM_TAG_BYTES = 16

/** base64url without padding; anything else is a corrupt payload, not a token. */
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** One entitlement inside a plan. Missing fields stay `null`, never invented. */
export interface ZcodeEntitlement {
  readonly showName: string | null
  readonly grantUnits: number | null
  readonly capabilities: readonly string[]
  readonly unitType: string | null
  readonly period: string | null
}

/** One purchased or granted plan. */
export interface ZcodePlan {
  readonly planId: string | null
  readonly name: string | null
  readonly status: string | null
  readonly startsAt: number | null
  readonly endsAt: number | null
  readonly entitlements: readonly ZcodeEntitlement[]
}

/** One quota bucket with its own period and expiry. */
export interface ZcodeBalance {
  readonly showName: string | null
  readonly totalUnits: number | null
  readonly usedUnits: number | null
  readonly remainingUnits: number | null
  readonly availableUnits: number | null
  readonly expiresAt: number | null
  readonly capabilities: readonly string[]
}

/** The whole billing answer, normalised for the UI. */
export interface ZcodeBillingSnapshot {
  readonly fetchedAt: number
  readonly plans: readonly ZcodePlan[]
  readonly balances: readonly ZcodeBalance[]
}

/** Injected side effects; the tests pass a mock fetch and a frozen clock. */
export interface BillingFetchDeps {
  readonly fetch: typeof fetch
  now(): number
}

/** Injected side effects of the caching reader. */
export interface BillingReaderDeps {
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly env: Record<string, string | undefined>
  /** Override {@link ZCODE_BILLING_CACHE_TTL_MS}; tests use a short window. */
  readonly ttlMs?: number
}

/** Options of one {@link BillingReader.read} call. */
export interface BillingReadOptions {
  /** `?refresh=1`: skip the cache for this call and replace its contents. */
  readonly force?: boolean
}

/** Process-wide reader with a 30-second success cache and single-flight. */
export interface BillingReader {
  read(options?: BillingReadOptions): Promise<ZcodeBillingSnapshot>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the secret the credential store was encrypted with.
 *
 * ZCode derives the fallback from the OS account it was signed in under, so a
 * credential file copied to another machine stops decrypting — that is the
 * point of the fallback, and the reason the panel reports a decrypt failure
 * instead of pretending there is no plan.
 */
export function deriveCredentialSecret(env: Record<string, string | undefined>): string {
  const explicit = env['ZCODE_CREDENTIAL_SECRET']
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return `zcode-credential-fallback:${process.platform}:${homedir()}:${String(env['USERNAME'])}`
}

function decodeBase64Url(part: string): Buffer {
  if (!BASE64URL.test(part)) {
    throw new ZcodeError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'The stored ZCode credential is not valid base64url')
  }
  return Buffer.from(part, 'base64url')
}

/**
 * Decrypt one `enc:v1:<iv>.<tag>.<ciphertext>` value.
 *
 * Exported for the offline vector test: a fixed key and a fixed plaintext are
 * encrypted in the test itself, so no real credential file is ever read.
 */
export function decryptCredentialValue(value: string, secret: string): string {
  if (!value.startsWith(CREDENTIAL_PREFIX)) {
    throw new ZcodeError(
      'ZCODE_CREDENTIAL_DECRYPT_FAILED',
      'The stored ZCode credential is not in the enc:v1 format this plugin understands',
    )
  }
  const parts = value.slice(CREDENTIAL_PREFIX.length).split('.')
  if (parts.length !== 3) {
    throw new ZcodeError(
      'ZCODE_CREDENTIAL_DECRYPT_FAILED',
      'The stored ZCode credential does not have the three base64url segments of an enc:v1 value',
    )
  }
  const [ivPart, tagPart, dataPart] = parts as [string, string, string]
  const iv = decodeBase64Url(ivPart)
  const tag = decodeBase64Url(tagPart)
  const data = decodeBase64Url(dataPart)
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES || data.length === 0) {
    throw new ZcodeError(
      'ZCODE_CREDENTIAL_DECRYPT_FAILED',
      'The stored ZCode credential has the wrong IV, tag or ciphertext length',
    )
  }
  const key = createHash('sha256').update(secret, 'utf8').digest()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    if (plaintext.length === 0) {
      throw new ZcodeError('ZCODE_CREDENTIAL_DECRYPT_FAILED', 'The stored ZCode credential decrypted to an empty token')
    }
    return plaintext
  } catch (error) {
    if (error instanceof ZcodeError) throw error
    throw new ZcodeError(
      'ZCODE_CREDENTIAL_DECRYPT_FAILED',
      'Cannot decrypt the stored ZCode credential; ZCODE_CREDENTIAL_SECRET does not match the value used at sign-in',
      { cause: error },
    )
  }
}

/** Read and decrypt the access token the billing endpoint accepts. */
async function readAccessToken(credentialsPath: string, env: Record<string, string | undefined>): Promise<string> {
  let raw: string
  try {
    raw = await readFile(credentialsPath, 'utf8')
  } catch (error) {
    throw new ZcodeError(
      'ZCODE_CREDENTIAL_MISSING',
      `Cannot read the ZCode credential store at ${credentialsPath}; sign in with the ZCode CLI first`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ZcodeError(
      'ZCODE_CREDENTIAL_INVALID',
      'The ZCode credential store is not valid JSON',
      { cause: error },
    )
  }
  if (!isRecord(parsed)) {
    throw new ZcodeError('ZCODE_CREDENTIAL_INVALID', 'The ZCode credential store is not a JSON object')
  }
  const encrypted = parsed['zcodejwttoken']
  if (typeof encrypted !== 'string' || encrypted.length === 0) {
    throw new ZcodeError('ZCODE_CREDENTIAL_INVALID', 'The ZCode credential store has no zcodejwttoken field')
  }
  return decryptCredentialValue(encrypted, deriveCredentialSecret(env))
}

/** Telemetry state holds the device id the billing endpoint requires. */
async function readDeviceMid(telemetryPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(telemetryPath, 'utf8'))
    if (!isRecord(parsed)) return undefined
    const value = parsed['deviceMid']
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    // A missing telemetry file is a supported state (first run, cleanup); the
    // endpoint answers 400/3001 and the caller reports BAD_REQUEST with the hint.
    return undefined
  }
}

function toEntitlement(value: unknown): ZcodeEntitlement | undefined {
  if (!isRecord(value)) return undefined
  return {
    showName: stringOrNull(value['show_name']),
    grantUnits: numberOrNull(value['grant_units']),
    capabilities: stringArray(value['capabilities']),
    unitType: stringOrNull(value['unit_type']),
    period: stringOrNull(value['period']),
  }
}

function toPlan(value: unknown): ZcodePlan | undefined {
  if (!isRecord(value)) return undefined
  const entitlements = Array.isArray(value['entitlements'])
    ? value['entitlements'].map(toEntitlement).filter((entry): entry is ZcodeEntitlement => entry !== undefined)
    : []
  return {
    planId: stringOrNull(value['plan_id']),
    name: stringOrNull(value['name']),
    status: stringOrNull(value['status']),
    startsAt: numberOrNull(value['starts_at']),
    endsAt: numberOrNull(value['ends_at']),
    entitlements,
  }
}

function toBalance(value: unknown): ZcodeBalance | undefined {
  if (!isRecord(value)) return undefined
  return {
    showName: stringOrNull(value['show_name']),
    totalUnits: numberOrNull(value['total_units']),
    usedUnits: numberOrNull(value['used_units']),
    remainingUnits: numberOrNull(value['remaining_units']),
    availableUnits: numberOrNull(value['available_units']),
    expiresAt: numberOrNull(value['expires_at']),
    capabilities: stringArray(value['capabilities']),
  }
}

/**
 * Read one billing snapshot from the service.
 *
 * Order of checks follows what the endpoint can answer: identity first, request
 * shape second, payload third. HTTP 400 is always the device-id hint because
 * that is the only parameter this client sends besides the bearer token.
 */
export async function fetchBillingSnapshot(
  env: Record<string, string | undefined>,
  deps: BillingFetchDeps,
): Promise<ZcodeBillingSnapshot> {
  const dataBaseDir = typeof env['ZCODE_DATA_BASE_DIR'] === 'string' ? env['ZCODE_DATA_BASE_DIR'].trim() : ''
  if (dataBaseDir.length === 0) {
    throw new ZcodeError(
      'ZCODE_ENV_MISSING',
      'ZCODE_DATA_BASE_DIR is not set; the ZCode credential store cannot be located',
    )
  }

  const stateDir = join(dataBaseDir, '.zcode', 'v2')
  const token = await readAccessToken(join(stateDir, 'credentials.json'), env)
  const deviceMid = await readDeviceMid(join(stateDir, 'telemetry-state.json'))

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'ZCode/3.4.0',
  }
  if (deviceMid !== undefined) headers['X-Device-Mid'] = deviceMid

  let response: Response
  try {
    response = await deps.fetch(ZCODE_BILLING_URL, { method: 'GET', headers })
  } catch (error) {
    throw new ZcodeError(
      'ZCODE_BILLING_HTTP',
      `Cannot reach the ZCode billing endpoint: ${sanitizeSecrets(describe(error))}`,
      { cause: error },
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new ZcodeError(
      'ZCODE_BILLING_UNAUTHORIZED',
      `The ZCode billing endpoint rejected the stored identity (HTTP ${response.status}); sign in with the ZCode CLI again`,
      { responseStatus: response.status },
    )
  }
  if (response.status === 400) {
    throw new ZcodeError(
      'ZCODE_BILLING_BAD_REQUEST',
      'The ZCode billing endpoint rejected the request (HTTP 400); its device id header is missing or not accepted',
      { responseStatus: response.status },
    )
  }
  if (!response.ok) {
    throw new ZcodeError(
      'ZCODE_BILLING_HTTP',
      `The ZCode billing endpoint answered HTTP ${response.status}`,
      { responseStatus: response.status },
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new ZcodeError('ZCODE_BILLING_PARSE', 'The ZCode billing endpoint did not return JSON', { cause: error })
  }
  if (!isRecord(payload)) {
    throw new ZcodeError('ZCODE_BILLING_PARSE', 'The ZCode billing payload is not a JSON object')
  }

  const code = payload['code']
  if (code !== 0) {
    const providerMessage = sanitizeSecrets(typeof payload['msg'] === 'string' ? payload['msg'] : '')
    if (code === 3001) {
      throw new ZcodeError(
        'ZCODE_BILLING_BAD_REQUEST',
        `The ZCode billing endpoint rejected the request (code 3001${providerMessage.length > 0 ? `: ${providerMessage}` : ''}); its device id header is missing`,
        { providerCode: 3001, providerMessage },
      )
    }
    throw new ZcodeError(
      'ZCODE_BILLING_HTTP',
      `The ZCode billing endpoint answered business code ${String(code)}${providerMessage.length > 0 ? `: ${providerMessage}` : ''}`,
      { providerMessage },
    )
  }

  const data = payload['data']
  if (!isRecord(data)) {
    throw new ZcodeError('ZCODE_BILLING_PARSE', 'The ZCode billing payload has no data object')
  }
  if (!Array.isArray(data['plans']) || !Array.isArray(data['balances'])) {
    throw new ZcodeError('ZCODE_BILLING_PARSE', 'The ZCode billing payload has no plans or balances array')
  }
  const plans = data['plans'].map(toPlan).filter((entry): entry is ZcodePlan => entry !== undefined)
  const balances = data['balances'].map(toBalance).filter((entry): entry is ZcodeBalance => entry !== undefined)

  return { fetchedAt: deps.now(), plans, balances }
}

/**
 * Wrap {@link fetchBillingSnapshot} with the 30-second cache the endpoint needs.
 *
 * Concurrent reads share one in-flight request: a card that mounts twice must
 * not spend two calls. Only successful reads enter the cache, and `force`
 * always replaces it, so "重新读取" can never show a stale snapshot.
 */
export function createBillingReader(deps: BillingReaderDeps): BillingReader {
  const ttlMs = deps.ttlMs ?? ZCODE_BILLING_CACHE_TTL_MS
  let cached: { readonly snapshot: ZcodeBillingSnapshot; readonly storedAt: number } | undefined
  let inflight: Promise<ZcodeBillingSnapshot> | undefined

  const read = (options?: BillingReadOptions): Promise<ZcodeBillingSnapshot> => {
    const force = options?.force === true
    if (!force && cached !== undefined && deps.now() - cached.storedAt < ttlMs) {
      return Promise.resolve(cached.snapshot)
    }
    if (inflight === undefined) {
      const pending = fetchBillingSnapshot(deps.env, { fetch: deps.fetch, now: deps.now }).then((snapshot) => {
        cached = { snapshot, storedAt: deps.now() }
        return snapshot
      })
      inflight = pending
      const clear = (): void => {
        if (inflight === pending) inflight = undefined
      }
      pending.then(clear, clear)
    }
    return inflight
  }

  return { read }
}

/* ────────────────────────────────────────────────────────────────────────────
 * A2 surface: state/quota contract used by the settings-page card.
 *
 * The block below was added on top of the panel reader above rather than
 * replacing it: `setupBillingRoutes` is already wired into `src/index.ts` and a
 * card ships against it, so the credential decryption, error classification and
 * single-flight logic stay shared. These exports differ only in the *shape*
 * they hand to the newer card: ISO timestamps, `modelId` alignment and a
 * reader that takes an explicit `dataBaseDir` instead of reading the env.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Ceiling on the upstream body copied into a failure, per the A2 contract. */
export const BILLING_BODY_SNIPPET_MAX_CHARS = 512

/**
 * One billing failure with the upstream status and a redacted body prefix.
 *
 * Extends {@link ZcodeError} so the existing panel handler (which switches on
 * `isZcodeError`) keeps working, and adds the two facts the newer card needs to
 * explain a failure: which HTTP status failed and what the service said.
 */
export class BillingError extends ZcodeError {
  /** First {@link BILLING_BODY_SNIPPET_MAX_CHARS} characters of the body, secrets redacted. */
  readonly bodySnippet: string | undefined

  constructor(
    code: ZcodeErrorCode,
    message: string,
    options: ZcodeErrorOptions & { readonly bodySnippet?: string } = {},
  ) {
    super(code, message, options)
    this.name = 'BillingError'
    this.bodySnippet = options.bodySnippet === undefined ? undefined : boundBodySnippet(options.bodySnippet)
  }
}

/** Replace every known secret verbatim, then the well-known credential shapes. */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('***')
  }
  return sanitizeSecrets(out)
}

function boundBodySnippet(text: string): string {
  const cleaned = text.trim()
  return cleaned.length <= BILLING_BODY_SNIPPET_MAX_CHARS
    ? cleaned
    : `${cleaned.slice(0, BILLING_BODY_SNIPPET_MAX_CHARS - 1)}…`
}

/**
 * Resolve the two values the billing endpoint needs, from one data root.
 *
 * `dataBaseDir` is the ZCode *data* root (`<root>/.zcode/v2/...`), not the
 * install directory: the credential store and the telemetry state are both
 * runtime artefacts. A missing store and a wrong secret are different failures
 * on purpose — the first is fixed by signing in, the second by running under
 * the same OS account, and a panel that merged them could not say which.
 *
 * @throws ZcodeError ZCODE_CREDENTIAL_MISSING when either file or the device id is absent
 * @throws ZcodeError ZCODE_CREDENTIAL_INVALID when the store is unreadable JSON
 * @throws ZcodeError ZCODE_CREDENTIAL_DECRYPT_FAILED when AES-256-GCM refuses the token
 */
export async function resolveZcodeCredential(
  dataBaseDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ readonly jwt: string; readonly deviceMid: string }> {
  const stateDir = join(dataBaseDir, '.zcode', 'v2')
  const jwt = await readAccessToken(join(stateDir, 'credentials.json'), env)
  const deviceMid = await readDeviceMid(join(stateDir, 'telemetry-state.json'))
  if (deviceMid === undefined) {
    // Fail closed *here* rather than sending a request the endpoint is known to
    // answer with 400/3001: the caller learns which local file is incomplete.
    throw new ZcodeError(
      'ZCODE_CREDENTIAL_MISSING',
      `The ZCode telemetry state at ${join(stateDir, 'telemetry-state.json')} has no deviceMid; sign in with the ZCode CLI first`,
    )
  }
  return { jwt, deviceMid }
}

/** One entitlement, keyed by the model id the balance rows also use. */
export interface ZcodeQuotaEntitlement {
  readonly modelId: string
  readonly grantUnits: number | null
}

/** One plan as the settings card renders it. ISO times, not epoch seconds. */
export interface ZcodeQuotaPlan {
  readonly planId: string | null
  readonly name: string | null
  readonly status: string | null
  readonly startsAt: string | null
  readonly endsAt: string | null
  /** Milliseconds until `endsAt`, clamped at 0; null when the plan has no end. */
  readonly remainingMs: number | null
  readonly entitlements: readonly ZcodeQuotaEntitlement[]
}

/** One balance row, keyed the same way as {@link ZcodeQuotaEntitlement}. */
export interface ZcodeQuotaBalance {
  readonly modelId: string
  readonly usedUnits: number | null
  readonly remainingUnits: number | null
}

/** Normalised billing answer handed to the settings card. */
export interface ZcodeQuotaSnapshot {
  /** ISO timestamp of the read, not of the service. */
  readonly fetchedAt: string
  readonly plans: readonly ZcodeQuotaPlan[]
  readonly balances: readonly ZcodeQuotaBalance[]
}

/** Options of one {@link fetchZcodeQuota} call. */
export interface FetchZcodeQuotaOptions {
  /** ZCode data root: the directory that contains `.zcode/v2/`. */
  readonly dataBaseDir: string
  /** Injected for the tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
  readonly env?: Record<string, string | undefined>
  /** Frozen clock for the tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * The model id of one entitlement/balance row.
 *
 * The service has answered with both spellings across releases: `model_id` in
 * the documented schema and `show_name` in the 1024-plan capture. Accepting
 * both is what makes `merged[]` alignable; inventing one when neither is
 * present is what a `null` model is for, so the row is dropped instead.
 */
function modelIdOf(value: Record<string, unknown>): string | null {
  return stringOrNull(value['model_id']) ?? stringOrNull(value['show_name'])
}

function toQuotaEntitlement(value: unknown): ZcodeQuotaEntitlement | undefined {
  if (!isRecord(value)) return undefined
  const modelId = modelIdOf(value)
  if (modelId === null) return undefined
  return { modelId, grantUnits: numberOrNull(value['grant_units']) }
}

function toQuotaPlan(value: unknown, now: number): ZcodeQuotaPlan | undefined {
  if (!isRecord(value)) return undefined
  const entitlements = Array.isArray(value['entitlements'])
    ? value['entitlements'].map(toQuotaEntitlement).filter((entry): entry is ZcodeQuotaEntitlement => entry !== undefined)
    : []
  const endsAtUnits = numberOrNull(value['ends_at'])
  return {
    planId: stringOrNull(value['plan_id']),
    name: stringOrNull(value['name']),
    status: stringOrNull(value['status']),
    startsAt: unixSecondsToIso(numberOrNull(value['starts_at'])),
    endsAt: unixSecondsToIso(endsAtUnits),
    remainingMs: endsAtUnits === null ? null : Math.max(0, endsAtUnits * 1000 - now),
    entitlements,
  }
}

function toQuotaBalance(value: unknown): ZcodeQuotaBalance | undefined {
  if (!isRecord(value)) return undefined
  const modelId = modelIdOf(value)
  if (modelId === null) return undefined
  return {
    modelId,
    usedUnits: numberOrNull(value['used_units']),
    remainingUnits: numberOrNull(value['remaining_units']),
  }
}

function unixSecondsToIso(value: number | null): string | null {
  return value === null ? null : new Date(value * 1000).toISOString()
}

/** Business code carried by the body, read without trusting the body to be JSON. */
function readBusinessCode(raw: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    return numberOrNull(parsed['code']) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Read one normalised billing snapshot.
 *
 * Error mapping is the documented one: 401/403 → identity, HTTP 400 with
 * business code 3001 → request shape, every other failure → transport/HTTP.
 * Each failure carries `responseStatus` and a secret-redacted `bodySnippet`;
 * neither the token nor the device id can appear in them because both are
 * replaced before truncation.
 */
export async function fetchZcodeQuota(options: FetchZcodeQuotaOptions): Promise<ZcodeQuotaSnapshot> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? (() => Date.now())
  const env = options.env ?? process.env
  const { jwt, deviceMid } = await resolveZcodeCredential(options.dataBaseDir, env)
  const secrets: readonly string[] = [jwt, deviceMid]

  let response: Response
  try {
    response = await fetchImpl(ZCODE_BILLING_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Device-Mid': deviceMid,
        Accept: 'application/json',
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    // A transport failure never carries the headers, so nothing to redact; the
    // cause is kept for the log, not for the card.
    throw new BillingError(
      'ZCODE_BILLING_HTTP',
      `Cannot reach the ZCode billing endpoint: ${sanitizeSecrets(describe(error))}`,
      { cause: error },
    )
  }

  const raw = await response.text()
  const snippet = boundBodySnippet(redactSecrets(raw, secrets))

  if (response.status === 401 || response.status === 403) {
    throw new BillingError(
      'ZCODE_BILLING_UNAUTHORIZED',
      `The ZCode billing endpoint rejected the stored identity (HTTP ${response.status}); sign in with the ZCode CLI again`,
      { responseStatus: response.status, bodySnippet: snippet },
    )
  }
  if (!response.ok) {
    const providerCode = readBusinessCode(raw)
    if (response.status === 400 && providerCode === 3001) {
      throw new BillingError(
        'ZCODE_BILLING_BAD_REQUEST',
        'The ZCode billing endpoint rejected the request (HTTP 400, code 3001); its device id header is missing or not accepted',
        { responseStatus: response.status, providerCode: 3001, bodySnippet: snippet },
      )
    }
    throw new BillingError(
      'ZCODE_BILLING_HTTP',
      `The ZCode billing endpoint answered HTTP ${response.status}`,
      { responseStatus: response.status, bodySnippet: snippet },
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    throw new BillingError('ZCODE_BILLING_PARSE', 'The ZCode billing endpoint did not return JSON', {
      cause: error,
      bodySnippet: snippet,
    })
  }
  if (!isRecord(payload)) {
    throw new BillingError('ZCODE_BILLING_PARSE', 'The ZCode billing payload is not a JSON object', {
      bodySnippet: snippet,
    })
  }

  const code = payload['code']
  const providerCode = numberOrNull(code)
  if (providerCode !== null && providerCode !== 0) {
    const providerMessage = sanitizeSecrets(typeof payload['msg'] === 'string' ? payload['msg'] : '')
    if (providerCode === 3001) {
      throw new BillingError(
        'ZCODE_BILLING_BAD_REQUEST',
        `The ZCode billing endpoint rejected the request (code 3001${providerMessage.length > 0 ? `: ${providerMessage}` : ''}); its device id header is missing`,
        { providerCode: 3001, providerMessage, bodySnippet: snippet },
      )
    }
    throw new BillingError(
      'ZCODE_BILLING_HTTP',
      `The ZCode billing endpoint answered business code ${String(providerCode)}${providerMessage.length > 0 ? `: ${providerMessage}` : ''}`,
      { providerCode, providerMessage, bodySnippet: snippet },
    )
  }

  const data = payload['data']
  if (!isRecord(data)) {
    throw new BillingError('ZCODE_BILLING_PARSE', 'The ZCode billing payload has no data object', {
      bodySnippet: snippet,
    })
  }
  if (!Array.isArray(data['plans']) || !Array.isArray(data['balances'])) {
    throw new BillingError('ZCODE_BILLING_PARSE', 'The ZCode billing payload has no plans or balances array', {
      bodySnippet: snippet,
    })
  }

  const nowMs = now()
  return {
    fetchedAt: new Date(nowMs).toISOString(),
    plans: data['plans'].map((value) => toQuotaPlan(value, nowMs)).filter((entry): entry is ZcodeQuotaPlan => entry !== undefined),
    balances: data['balances'].map(toQuotaBalance).filter((entry): entry is ZcodeQuotaBalance => entry !== undefined),
  }
}

/** Options of {@link createQuotaReader}. */
export interface QuotaReaderOptions {
  readonly dataBaseDir: string
  readonly fetchImpl?: typeof fetch
  readonly env?: Record<string, string | undefined>
  readonly now?: () => number
  /** Override the 30-second window; the tests use a short one. */
  readonly ttlMs?: number
}

/** Options of one {@link QuotaReader.read} call. */
export interface QuotaReadOptions {
  /** `?refresh=1`: skip the cache, replace it on success. */
  readonly refresh?: boolean
  readonly signal?: AbortSignal
}

/** Process-wide quota reader: 30-second success cache plus single-flight. */
export interface QuotaReader {
  read(options?: QuotaReadOptions): Promise<ZcodeQuotaSnapshot>
}

/**
 * Wrap {@link fetchZcodeQuota} with the cache the card needs.
 *
 * Two rules keep the panel honest:
 * - only successful reads are cached, so a failure never looks fresh;
 * - concurrent calls share one in-flight request, so a card mounting twice
 *   cannot spend two upstream calls (and a burst of `refresh=1` cannot either).
 */
export function createQuotaReader(options: QuotaReaderOptions): QuotaReader {
  const ttlMs = options.ttlMs ?? ZCODE_BILLING_CACHE_TTL_MS
  const now = options.now ?? (() => Date.now())
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  let cached: { readonly snapshot: ZcodeQuotaSnapshot; readonly storedAt: number } | undefined
  let inflight: Promise<ZcodeQuotaSnapshot> | undefined

  const read = (readOptions?: QuotaReadOptions): Promise<ZcodeQuotaSnapshot> => {
    const refresh = readOptions?.refresh === true
    if (!refresh && cached !== undefined && now() - cached.storedAt < ttlMs) {
      return Promise.resolve(cached.snapshot)
    }
    if (inflight === undefined) {
      const pending = fetchZcodeQuota({
        dataBaseDir: options.dataBaseDir,
        fetchImpl,
        now,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      }).then((snapshot) => {
        cached = { snapshot, storedAt: now() }
        return snapshot
      })
      inflight = pending
      const clear = (): void => {
        if (inflight === pending) inflight = undefined
      }
      pending.then(clear, clear)
    }
    return inflight
  }

  return { read }
}
