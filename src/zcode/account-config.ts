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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  /** Every revision must differ (monotonic string); defaults to a timestamp. */
  readonly revisionSeed?: string
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
  if (target === undefined) {
    throw new Error(`ZCODE_ACCOUNT_CONFIG_INVALID: no account provider for accountType=${options.accountType} mode=${options.mode}`)
  }

  // The exact accepted form, verified against zcode.cjs and a live run.
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${revision}:${hash(resolve(options.builtinPath))}`
  const revisionSeed = options.revisionSeed ?? `account:${Date.now()}`

  const providers: Record<string, { access: { type: 'zhipu-account'; entitled: boolean }; builtinModelIds?: string[] }> = {}
  const states: Record<string, { availability: 'available' | 'unavailable'; entitled: boolean; current: boolean; unavailableReason?: string }> = {}
  for (const entry of entries) {
    const on = entry.providerId === target.providerId
    providers[entry.providerId] = on
      ? { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: [...entry.modelIds] }
      : { access: { type: 'zhipu-account', entitled: false } }
    states[entry.providerId] = on
      ? { availability: 'available', entitled: true, current: true }
      : { availability: 'unavailable', entitled: false, current: false, unavailableReason: 'not-connected' }
  }

  return {
    basedOnZCodeBuiltinRevision,
    updateParams: {
      revision: revisionSeed,
      basedOnZCodeBuiltinRevision,
      providers,
      states,
    },
    entries,
    providerId: target.providerId,
  }
}
