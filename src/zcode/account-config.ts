/**
 * Build the `provider/updateAccountConfig` payload from the ZCode builtin
 * provider config.
 *
 * The builtin file (`zcode-builtin.json`, `revision` at the top level) lists
 * every account provider under `config.providerConfigRules.providerRules`
 * with a `providerId` prefixed `account:`. The injection mirrors what the real
 * ZCode client sends: all ten account providers, each with
 * `access.{type,entitled}` and `builtinModelIds`, plus per-provider state.
 *
 * The builtin-revision tag is the exact string the CLI accepts:
 * `zcode-builtin:<release.revision>:<sha256(path.resolve(builtinPath))>`
 * (hex, no separators). Anything else makes the registry treat the update as
 * stale and silently drop it.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The `zcode-builtin:<revision>:<hash>` tag the running ZCode runtime actually
 * reports, read from the desktop client's own delivery lines in its log (every
 * "account provider config 已交付" entry echoes the tag the registry accepted).
 * Reading it from the log also makes the injection self-adapting: when the
 * desktop updates and the builtin revision moves, the next delivery line
 * carries the new tag and this picks it up without a plugin change.
 */
export function readRuntimeBuiltinRevisionTag(logDir?: string): string | undefined {
  // The log scan reads up to three multi-megabyte files and this runs once per
  // turn; a short TTL keeps a desktop upgrade visible within a minute without
  // paying the scan every request. Explicit directories (tests) bypass the cache.
  if (logDir === undefined) {
    const now = Date.now()
    if (tagCache !== undefined && now - tagCacheAt < TAG_CACHE_TTL_MS) return tagCache
    const tag = scanRuntimeBuiltinRevisionTag(defaultRuntimeLogDir())
    if (tag !== undefined) {
      tagCache = tag
      tagCacheAt = now
    }
    return tag
  }
  return scanRuntimeBuiltinRevisionTag(logDir)
}

const TAG_CACHE_TTL_MS = 60_000
let tagCache: string | undefined
let tagCacheAt = 0

function scanRuntimeBuiltinRevisionTag(directory: string): string | undefined {
  if (directory.length === 0) return undefined
  let names: string[]
  try {
    names = readdirSync(directory).sort().reverse().slice(0, 3)
  } catch {
    return undefined
  }
  for (const name of names) {
    let text: string
    try {
      text = readFileSync(resolve(directory, name), 'utf8')
    } catch {
      continue
    }
    const last = [...text.matchAll(/zcode-builtin:(\d+):([0-9a-f]{64})/g)].at(-1)
    if (last?.[1] !== undefined && last[2] !== undefined) {
      return `zcode-builtin:${last[1]}:${last[2]}`
    }
  }
  return undefined
}

let cachedLogDir: string | undefined
function defaultRuntimeLogDir(): string {
  if (cachedLogDir === undefined) {
    const base = process.env['ZCODE_DATA_BASE_DIR']?.trim() ?? ''
    cachedLogDir = base.length > 0 ? resolve(base, '.zcode', 'v2', 'logs') : ''
  }
  return cachedLogDir
}

/** One account provider read from the builtin table. */
export interface ZcodeAccountProviderEntry {
  readonly providerId: string
  readonly modelIds: readonly string[]
  readonly baseUrl: string
  readonly mode: string
  readonly accountType: 'zai' | 'bigmodel'
}

export interface ZcodeAccountConfig {
  readonly basedOnZCodeBuiltinRevision: string
  readonly updateParams: {
    readonly revision: string
    readonly basedOnZCodeBuiltinRevision: string
    readonly providers: Readonly<Record<string, {
      readonly access: { readonly type: 'zhipu-account'; readonly entitled: boolean }
      readonly builtinModelIds?: readonly string[]
    }>>
    readonly states: Readonly<Record<string, {
      readonly availability: 'available' | 'unavailable' | 'unknown'
      readonly entitled: boolean
      readonly current: boolean
      readonly connectionKey: string
      readonly unavailableReason?: string
    }>>
  }
  readonly entries: readonly ZcodeAccountProviderEntry[]
  /** The injected providerId this plan resolves to. */
  readonly providerId: string
}

export interface BuildAccountConfigOptions {
  readonly builtinPath: string
  readonly accountType: 'zai' | 'bigmodel'
  /** Target mode, e.g. `start-plan`. */
  readonly mode: string
  /** Overrides the canonical revision (tests pin determinism); defaults to canonical. */
  readonly revisionSeed?: string
  /** Models the injected target provider advertises; defaults to the builtin list. */
  readonly modelIds?: readonly string[] | undefined
  /** Overrides the start-plan connection key (defaults to the desktop sample). */
  readonly connectionKey?: string | undefined
  /** Overrides the builtin revision tag (tests); defaults to the runtime-reported one. */
  readonly builtinRevisionTag?: string | undefined
  /** Log directory the runtime-reported tag is read from (tests inject an empty dir). */
  readonly runtimeLogDir?: string | undefined
  readonly readFile?: ((path: string) => string) | undefined
  readonly hash?: ((text: string) => string) | undefined
}

/** Entry shape inside `providerRules` we rely on. */
interface BuiltinProviderRule {
  providerId?: unknown
  config?: {
    access?: { type?: unknown; mode?: unknown; accountType?: unknown }
    api?: { baseUrl?: unknown }
    builtinModelIds?: unknown
  }
}

/**
 * Read the builtin config and produce the injection payload.
 *
 * @throws Error (code `ZCODE_ACCOUNT_CONFIG_INVALID` in `message`) when the
 * file is unreadable, not JSON, or the target mode is not in the table.
 */
export function buildZcodeAccountConfig(options: BuildAccountConfigOptions): ZcodeAccountConfig {
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const hash = options.hash ?? ((text: string): string => createHash('sha256').update(text).digest('hex'))

  let raw: string
  try {
    raw = readFile(options.builtinPath)
  } catch (cause) {
    throw new Error(`ZCODE_ACCOUNT_CONFIG_INVALID: cannot read builtin provider config at ${options.builtinPath}`, { cause })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error('ZCODE_ACCOUNT_CONFIG_INVALID: builtin provider config is not valid JSON', { cause })
  }
  const doc = parsed as {
    revision?: unknown
    config?: { providerConfigRules?: { providerRules?: BuiltinProviderRule[] | Record<string, BuiltinProviderRule> } }
  }
  const rawRevision = doc.revision
  const revision = typeof rawRevision === 'number' ? String(rawRevision) : rawRevision
  const rawRules = doc.config?.providerConfigRules?.providerRules
  // The live builtin file (revision 33) ships providerRules as an array of rule
  // objects; accept a record of rule objects as well, for free.
  const rules: BuiltinProviderRule[] | undefined = Array.isArray(rawRules)
    ? rawRules
    : rawRules !== undefined && typeof rawRules === 'object'
      ? Object.values(rawRules as Record<string, BuiltinProviderRule>)
      : undefined
  if (typeof revision !== 'string' || revision.length === 0 || !Array.isArray(rules)) {
    throw new Error('ZCODE_ACCOUNT_CONFIG_INVALID: builtin config has no revision or providerRules')
  }

  const entries: ZcodeAccountProviderEntry[] = []
  for (const rule of rules) {
    const providerId = rule.providerId
    if (typeof providerId !== 'string' || !providerId.startsWith('account:')) continue
    const access = rule.config?.access ?? {}
    const accountType = access.accountType
    if (accountType !== 'zai' && accountType !== 'bigmodel') continue
    const baseUrl = rule.config?.api?.baseUrl
    const mode = access.mode
    if (typeof baseUrl !== 'string' || typeof mode !== 'string') continue
    const modelIds = Array.isArray(rule.config?.builtinModelIds)
      ? rule.config.builtinModelIds.filter((id): id is string => typeof id === 'string')
      : []
    entries.push({ providerId, modelIds, baseUrl, mode, accountType })
  }
  if (entries.length === 0) {
    throw new Error('ZCODE_ACCOUNT_CONFIG_INVALID: builtin config lists no account: providers')
  }

  const target = entries.find(entry => entry.accountType === options.accountType && entry.mode === options.mode)
  const advertised = options.modelIds ?? target?.modelIds ?? []
  if (target === undefined) {
    throw new Error(`ZCODE_ACCOUNT_CONFIG_INVALID: no account provider for accountType=${options.accountType} mode=${options.mode}`)
  }

  // The exact accepted form, verified against zcode.cjs, the desktop log's
  // delivery payload (2026-10-25), and probe3/probe5 end-to-end runs
  // (2026-10-26): the revision must be the canonical `account:[basedOn,
  // providersArray, states]` string — a bare timestamp revision is accepted at
  // the envelope layer (`received`) but the account layer never activates,
  // which surfaced as provider_not_found at session/send.
  //
  // The hash half of basedOn is computed by the runtime over a shape we cannot
  // reproduce externally (path hash, file-content hash and canonical
  // serialization were all tested and none matched), so the authoritative tag
  // is the one the runtime itself reported — read from the desktop delivery
  // log; the self-computed tag remains the fallback for a machine without
  // desktop logs.
  const fallbackTag = `zcode-builtin:${revision}:${hash(resolve(options.builtinPath))}`
  const basedOnZCodeBuiltinRevision = options.builtinRevisionTag
    ?? (options.runtimeLogDir === undefined ? readRuntimeBuiltinRevisionTag() : readRuntimeBuiltinRevisionTag(options.runtimeLogDir))
    ?? fallbackTag

  const providers: Record<string, { access: { type: 'zhipu-account'; entitled: boolean }; builtinModelIds?: string[] }> = {}
  const states: Record<string, { availability: 'available' | 'unavailable'; entitled: boolean; current: boolean; connectionKey: string; unavailableReason?: string }> = {}
  for (const entry of entries) {
    const on = entry.providerId === target.providerId
    // The snapshot is ours, not a faithful copy of the builtin table: the target
    // provider advertises exactly the models this adapter offers, so GLM-5.3 can
    // run on the start plan even though the builtin table omits it.
    providers[entry.providerId] = on
      ? { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: [...advertised] }
      : { access: { type: 'zhipu-account', entitled: false } }
    states[entry.providerId] = on
      ? { availability: 'available', entitled: true, current: true, connectionKey: options.connectionKey ?? DEFAULT_START_PLAN_CONNECTION_KEY }
      : { availability: 'unavailable', entitled: false, current: false, connectionKey: DEFAULT_OFF_CONNECTION_KEY, unavailableReason: 'not-connected' }
  }

  // Canonical revision the registry compares and echoes back: providers embed
  // as the [{providerId, config}] array form even though the wire field is a
  // record (mirror of the desktop client's construction).
  const providersArray = Object.entries(providers).map(([providerId, config]) => ({ providerId, config }))
  const revisionValue = options.revisionSeed ?? `account:${JSON.stringify([basedOnZCodeBuiltinRevision, providersArray, states])}`

  return {
    basedOnZCodeBuiltinRevision,
    updateParams: {
      revision: revisionValue,
      basedOnZCodeBuiltinRevision,
      providers,
      states,
    },
    entries,
    providerId: target.providerId,
  }
}

/**
 * Connection key the desktop client sends for the start-plan slot (read from
 * the 2026-10-25 desktop delivery log; probe3 confirmed the account layer
 * activates with this value). It keys the connection identity in the registry
 * states — without it the injection is received but the free-plan view never
 * appears in the model catalog.
 */
export const DEFAULT_START_PLAN_CONNECTION_KEY = '0132285dc3675ec4eb4abf92aa3d2514abc6701b0d7c806be9e1acfcc558052d'
/** Shared key for the not-connected slots (desktop sample value). */
export const DEFAULT_OFF_CONNECTION_KEY = '41717a7a173a5e88981ed3b30d6c754715277dce3b302a8e7b1386cdf57b9b4c'
