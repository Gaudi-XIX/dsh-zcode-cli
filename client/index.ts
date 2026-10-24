/**
 * Browser half of the ZCode provider: the card the host renders inside the
 * provider row on 设置 → 模型.
 *
 * Why it exists: the Node half registers the directory entry
 * (`ctx.llm.registerConfigurableProviders`, `settingsNs: 'dsh-zcode-provider'`
 * in `src/index.ts`), and the host then renders that row's body by dispatching
 * the keyed slot `settings.models.provider-card` for the entry whose registered
 * `key` equals the row's `settingsNs` **verbatim**. With no client half there is
 * no entry under that key, and the host does not fall back to a generic form —
 * the row body stays empty. This file is that entry.
 *
 * Scope: quota, plans and a read-only information panel. The quota and plan
 * blocks are filled from the plugin's own loopback route
 * (`GET /plugins/zcode-provider/billing`, mounted by `src/web/router.ts`),
 * because the access token never leaves the Node half. Everything below the
 * divider is a compile-time mirror of the Node half or a value read out of the
 * slot props the host does pass — `{ provider, configured, keyConfigured }`
 * (app.asar ModelsSection, `renderSlot('settings.models.provider-card',
 * {provider, configured, keyConfigured}, {entryKey})`). Nothing here can throw
 * on a missing prop: the host wraps each slot entry in `SlotErrorBoundary`,
 * which renders an empty element on a throw — a card that crashes looks exactly
 * like the empty row this file is fixing.
 */

import type { Context } from '@deepseek-ai/cordis'

import { en, NS, zh, type ZcodeLocaleKey } from './locales.js'

/** The subset of React the card uses; `react` itself is a host-provided external. */
type ReactApi = {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
  useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void]
  useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void
}
const R = require('react') as ReactApi
const { createElement: h, useState, useEffect } = R

/** The locale service slice this card binds to. */
interface LocaleLike {
  register(namespace: string, language: string, dictionary: Record<string, string>): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  subscribe(listener: () => void): () => void
}

/** The slot service slice this card registers on. */
interface SlotsLike {
  inject(name: string, register: () => () => void): void
  register(
    options: {
      name: string
      key?: string
      id: string
      order?: number
      label?: string | (() => string)
      locale?: string
    },
    Component: (props?: unknown) => unknown,
  ): () => void
}

export interface ClientContext extends Context {
  slots: SlotsLike
  locale: LocaleLike
}

export const name = 'dsh-zcode-provider-client'

/**
 * Cordis `inject` entries are hard dependencies: touching a service that is not
 * listed throws. `locale` is declared because `apply` reads `ctx.locale`; the
 * locales themselves are registered below, so the card never renders a raw key.
 */
export const inject = ['slots', 'locale']

// ── Mirrored facts from the Node half ──────────────────────────────────────
// These are literals on purpose. Importing `src/provider/config.ts` would drag
// `@deepseek-ai/schemastery` and the adapter's whole module graph into the
// browser bundle, where a missing host module throws at load time and the card
// blanks out. `tests/client.test.mjs` pins every literal below to the source it
// mirrors, so drift fails the gate instead of quietly lying on the settings page.

/** MUST equal `ZCODE_SETTINGS_NS` in `src/index.ts`; this is the slot key. */
const SETTINGS_NS = 'dsh-zcode-provider'
/** MUST equal `ZCODE_PROVIDER_ROUTE` in `src/index.ts`. */
const PROVIDER_ROUTE = 'zcode'
/** Slot registration id; unique per card, not a contract with the host. */
const CARD_ID = 'zcode-provider-card'
/** MUST equal `DEFAULT_MODEL` in `src/provider/config.ts`. */
const DEFAULT_MODEL = 'GLM-5.3-Flash'
/** MUST equal the ids of `DEFAULT_MODELS` in `src/provider/config.ts`. */
const MODELS: readonly string[] = ['GLM-5.3-Flash', 'GLM-5.3']
/** MUST equal `DEFAULT_NODE_PATH` / `DEFAULT_ZCODE_CJS_PATH` in `src/provider/config.ts`. */
const NODE_PATH = 'D:\\nodejs\\node.exe'
const ZCODE_CJS_PATH = 'F:\\AgentData\\zcode\\cli\\resources\\glm\\zcode.cjs'
/** MUST equal `BILLING_ROUTE_PATH` in `src/web/router.ts`. */
const BILLING_PATH = '/plugins/zcode-provider/billing'
/** MUST equal `ZCODE_STATE_ROUTE_PATH` in `src/web/router.ts`. */
const STATE_PATH = '/plugins/dsh-zcode-provider/state'

/** One row of the environment contract shown on the card. */
interface EnvRow {
  readonly name: string
  readonly expected: string
  readonly descriptionKey: ZcodeLocaleKey
}

/**
 * MUST equal `ZCODE_ENV_CONTRACT` in `src/zcode/process.ts` (names and expected
 * values; `NODE_OPTIONS` is listed with the flags the provider contributes).
 */
const ENV_CONTRACT: readonly EnvRow[] = [
  {
    name: 'ZCODE_HOME',
    expected: 'F:\\AgentData\\zcode\\data\\.zcode',
    descriptionKey: 'card.env.ZCODE_HOME',
  },
  {
    name: 'ZCODE_DATA_BASE_DIR',
    expected: 'F:\\AgentData\\zcode\\data',
    descriptionKey: 'card.env.ZCODE_DATA_BASE_DIR',
  },
  {
    name: 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
    expected: 'F:\\AgentData\\zcode\\cli\\resources\\config\\provider\\zcode-builtin.json',
    descriptionKey: 'card.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
  },
  {
    name: 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
    expected: 'F:\\AgentData\\zcode\\data\\.zcode\\v2\\provider_config.json',
    descriptionKey: 'card.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
  },
  {
    name: 'NODE_OPTIONS',
    expected: '--no-network-family-autoselection --dns-result-order=ipv4first',
    descriptionKey: 'card.env.NODE_OPTIONS',
  },
]

// ── Billing payload mirrors ─────────────────────────────────────────────────
// Field names match `src/zcode/billing.ts`; every optional field is nullable so
// a missing server field renders as "—" instead of a fabricated number.

interface BillingEntitlement {
  readonly showName: string | null
  readonly grantUnits: number | null
  readonly capabilities: readonly string[]
  readonly unitType: string | null
  readonly period: string | null
}

interface BillingPlan {
  readonly planId: string | null
  readonly name: string | null
  readonly status: string | null
  readonly startsAt: number | null
  readonly endsAt: number | null
  readonly entitlements: readonly BillingEntitlement[]
}

interface BillingBalance {
  readonly showName: string | null
  readonly totalUnits: number | null
  readonly usedUnits: number | null
  readonly remainingUnits: number | null
  readonly availableUnits: number | null
  readonly expiresAt: number | null
  readonly capabilities: readonly string[]
}

interface BillingSnapshot {
  readonly fetchedAt: number
  readonly plans: readonly BillingPlan[]
  readonly balances: readonly BillingBalance[]
}

/** What the two panels need to render; one state machine, no boolean soup. */
type BillingView =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: BillingSnapshot }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

/** Style constants. Only host-neutral values: no themed CSS variables are assumed. */
const S = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    fontSize: '12.5px',
    lineHeight: 1.6,
    color: 'inherit',
    padding: '2px 0',
  },
  header: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  title: { fontWeight: 700, fontSize: '13.5px' },
  badge: {
    padding: '1px 7px',
    borderRadius: '999px',
    fontSize: '11px',
    border: '1px solid rgba(128, 128, 128, 0.45)',
    opacity: 0.85,
  },
  section: { display: 'flex', flexDirection: 'column', gap: '3px' },
  sectionTitle: { fontWeight: 600, fontSize: '12px', opacity: 0.85 },
  row: { display: 'grid', gridTemplateColumns: 'minmax(104px, max-content) 1fr', gap: '2px 10px', alignItems: 'baseline' },
  label: { opacity: 0.7 },
  value: { wordBreak: 'break-word' },
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    wordBreak: 'break-all',
  },
  note: { opacity: 0.7, fontSize: '11.5px' },
  divider: { height: '1px', background: 'rgba(128, 128, 128, 0.25)', margin: '1px 0' },
  quotaRow: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '4px' },
  quotaHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
  quotaName: { fontWeight: 600 },
  quotaAmount: { fontVariantNumeric: 'tabular-nums' },
  progressTrack: {
    position: 'relative',
    height: '6px',
    borderRadius: '999px',
    background: 'rgba(128, 128, 128, 0.22)',
    overflow: 'hidden',
  },
  progressFill: {
    position: 'absolute',
    inset: '0 auto 0 0',
    background: 'rgba(64, 156, 255, 0.75)',
    borderRadius: '999px',
  },
  planBlock: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '4px' },
  entitlement: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, max-content) 1fr',
    gap: '2px 10px',
    alignItems: 'baseline',
    paddingLeft: '10px',
  },
  errorText: { fontWeight: 600 },
  controls: { display: 'flex', flexDirection: 'column', gap: '4px' },
  control: {
    display: 'grid',
    gridTemplateColumns: 'minmax(104px, max-content) 1fr',
    gap: '2px 10px',
    alignItems: 'center',
  },
  select: {
    font: 'inherit',
    fontSize: '12px',
    padding: '2px 6px',
    borderRadius: '6px',
    border: '1px solid rgba(128, 128, 128, 0.45)',
    background: 'transparent',
    color: 'inherit',
    maxWidth: '100%',
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: '2px',
    padding: '2px 10px',
    fontSize: '11.5px',
    borderRadius: '6px',
    border: '1px solid rgba(128, 128, 128, 0.45)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
} as const

/** Read a string prop without assuming the host kept the documented shape. */
function propString(props: unknown, key: string): string | undefined {
  if (props === null || typeof props !== 'object') return undefined
  const value = (props as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Read a boolean prop; `undefined` means "the host did not say". */
function propBoolean(props: unknown, key: string): boolean | undefined {
  if (props === null || typeof props !== 'object') return undefined
  const value = (props as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

/** One `label: value` line of a section. */
function row(label: string, value: unknown, mono = false): unknown {
  return h(
    'div',
    { style: S.row },
    h('span', { style: S.label }, label),
    h('span', { style: mono ? { ...S.value, ...S.mono } : S.value }, value),
  )
}

/** A titled block of rows. */
function section(title: string, children: readonly unknown[]): unknown {
  return h('div', { style: S.section }, h('span', { style: S.sectionTitle }, title), ...children)
}

// ── Billing formatting and rendering helpers ────────────────────────────────

/** One formatter for every timestamp; the zone is explicit, never the host's. */
const SHANGHAI_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** `YYYY-MM-DD HH:mm` in Asia/Shanghai; `undefined` when the field is absent. */
function formatTimestamp(seconds: number | null): string | undefined {
  if (seconds === null) return undefined
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return undefined
  const parts = SHANGHAI_TIME.formatToParts(date)
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}

/** Token counts in 万 / 亿, which is how the plan is sold. */
function formatUnits(value: number | null, t: (key: ZcodeLocaleKey) => string): string {
  if (value === null) return t('card.placeholder')
  const magnitude = Math.abs(value)
  if (magnitude >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} ${t('card.unit.yi')}`
  if (magnitude >= 10_000) return `${(value / 10_000).toFixed(1)} ${t('card.unit.wan')}`
  return new Intl.NumberFormat('en-US').format(value)
}

/** Remaining share in whole percent; `null` when the server sent no total. */
function sharePercent(remaining: number | null, total: number | null): number | null {
  if (remaining === null || total === null || total <= 0 || remaining < 0) return null
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readEntitlement(value: unknown): BillingEntitlement | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  return {
    showName: readString(record['showName']),
    grantUnits: readNumber(record['grantUnits']),
    capabilities: readStringArray(record['capabilities']),
    unitType: readString(record['unitType']),
    period: readString(record['period']),
  }
}

function readPlan(value: unknown): BillingPlan | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const entitlements = Array.isArray(record['entitlements'])
    ? record['entitlements']
        .map(readEntitlement)
        .filter((entry): entry is BillingEntitlement => entry !== undefined)
    : []
  return {
    planId: readString(record['planId']),
    name: readString(record['name']),
    status: readString(record['status']),
    startsAt: readNumber(record['startsAt']),
    endsAt: readNumber(record['endsAt']),
    entitlements,
  }
}

function readBalance(value: unknown): BillingBalance | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  return {
    showName: readString(record['showName']),
    totalUnits: readNumber(record['totalUnits']),
    usedUnits: readNumber(record['usedUnits']),
    remainingUnits: readNumber(record['remainingUnits']),
    availableUnits: readNumber(record['availableUnits']),
    expiresAt: readNumber(record['expiresAt']),
    capabilities: readStringArray(record['capabilities']),
  }
}

/** Validate the `{ ok, data }` envelope; a wrong shape is an error, not zeros. */
function readEnvelope(body: unknown): BillingView {
  const record = recordOf(body)
  if (record === undefined) return { status: 'failed', code: 'ZCODE_BILLING_PARSE', message: '' }
  if (record['ok'] !== true) {
    const error = recordOf(record['error'])
    const code = error === undefined ? undefined : readString(error['code'])
    const message = error === undefined ? null : readString(error['message'])
    return code === null || code === undefined
      ? { status: 'failed', code: 'ZCODE_BILLING_PARSE', message: '' }
      : { status: 'failed', code, message: message ?? '' }
  }
  const data = recordOf(record['data'])
  if (data === undefined) return { status: 'failed', code: 'ZCODE_BILLING_PARSE', message: '' }
  if (!Array.isArray(data['plans']) || !Array.isArray(data['balances'])) {
    return { status: 'failed', code: 'ZCODE_BILLING_PARSE', message: '' }
  }
  return {
    status: 'ready',
    snapshot: {
      fetchedAt: readNumber(data['fetchedAt']) ?? Date.now(),
      plans: data['plans'].map(readPlan).filter((entry): entry is BillingPlan => entry !== undefined),
      balances: data['balances'].map(readBalance).filter((entry): entry is BillingBalance => entry !== undefined),
    },
  }
}

/** One GET against the plugin route; `force` maps to `?refresh=1`. */
async function requestBilling(force: boolean, signal: AbortSignal): Promise<BillingView> {
  const response = await fetch(force ? `${BILLING_PATH}?refresh=1` : BILLING_PATH, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    return { status: 'failed', code: 'ZCODE_BILLING_HTTP', message: `HTTP ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: 'failed', code: 'ZCODE_BILLING_PARSE', message: '' }
  }
  return readEnvelope(body)
}

/** One selectable option as the state route reports it. */
interface SelectionOption {
  readonly id: string
  readonly label: string
  readonly available?: boolean
  readonly reason?: string
}

/** What the run-configuration block edits. */
interface SelectionState {
  readonly channel: string
  readonly model: string
  readonly effort: string
  readonly models: readonly SelectionOption[]
  readonly efforts: readonly SelectionOption[]
  readonly channels: readonly SelectionOption[]
}

/** Load/write state of the run-configuration block. */
type SelectionView =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly state: SelectionState }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

function readOptions(value: unknown): readonly SelectionOption[] {
  if (!Array.isArray(value)) return []
  const options: SelectionOption[] = []
  for (const entry of value) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const id = readString(record['id'])
    if (id === null) continue
    const label = readString(record['label']) ?? id
    const available = typeof record['available'] === 'boolean' ? record['available'] : undefined
    const reason = readString(record['reason'])
    options.push({
      id,
      label,
      ...(available === undefined ? {} : { available }),
      ...(reason === null ? {} : { reason }),
    })
  }
  return options
}

/** Parse a `GET /state` envelope; anything unexpected becomes a failure view. */
function readSelectionEnvelope(body: unknown): SelectionView {
  const record = recordOf(body)
  if (record === undefined || record['ok'] !== true) {
    const error = record === undefined ? null : readString(record['error'])
    return { status: 'failed', code: error ?? 'STATE_UNAVAILABLE', message: '' }
  }
  const state = recordOf(record['state'])
  if (state === undefined) return { status: 'failed', code: 'STATE_UNAVAILABLE', message: '' }
  const channel = readString(state['channel'])
  const model = readString(state['model'])
  const effort = readString(state['effort'])
  if (channel === null || model === null || effort === null) {
    return { status: 'failed', code: 'STATE_UNAVAILABLE', message: '' }
  }
  return {
    status: 'ready',
    state: {
      channel,
      model,
      effort,
      models: readOptions(state['models']),
      efforts: readOptions(state['efforts']),
      channels: readOptions(state['channels']),
    },
  }
}

/** One GET against the state route. */
async function requestState(signal: AbortSignal): Promise<SelectionView> {
  const response = await fetch(STATE_PATH, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) {
    return { status: 'failed', code: `HTTP_${response.status}`, message: `HTTP ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: 'failed', code: 'STATE_UNAVAILABLE', message: '' }
  }
  return readSelectionEnvelope(body)
}

/** One POST against the state route; the answer carries the new state. */
async function writeSelection(patch: Record<string, string>, signal: AbortSignal): Promise<SelectionView> {
  const response = await fetch(STATE_PATH, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: 'failed', code: `HTTP_${response.status}`, message: `HTTP ${response.status}` }
  }
  if (!response.ok) {
    const record = recordOf(body)
    const error = record === undefined ? null : readString(record['error'])
    return { status: 'failed', code: error ?? `HTTP_${response.status}`, message: '' }
  }
  return readSelectionEnvelope(body)
}

/** Human explanations keyed by the Node half's error codes. */
const FAILURE_REASON: Record<string, ZcodeLocaleKey> = {
  ZCODE_CREDENTIAL_MISSING: 'card.billing.error.ZCODE_CREDENTIAL_MISSING',
  ZCODE_CREDENTIAL_INVALID: 'card.billing.error.ZCODE_CREDENTIAL_INVALID',
  ZCODE_CREDENTIAL_DECRYPT_FAILED: 'card.billing.error.ZCODE_CREDENTIAL_DECRYPT_FAILED',
  ZCODE_BILLING_UNAUTHORIZED: 'card.billing.error.ZCODE_BILLING_UNAUTHORIZED',
  ZCODE_BILLING_BAD_REQUEST: 'card.billing.error.ZCODE_BILLING_BAD_REQUEST',
  ZCODE_BILLING_HTTP: 'card.billing.error.ZCODE_BILLING_HTTP',
  ZCODE_BILLING_PARSE: 'card.billing.error.ZCODE_BILLING_PARSE',
  ZCODE_ENV_MISSING: 'card.billing.error.ZCODE_ENV_MISSING',
}

function progressBar(percent: number): unknown {
  return h(
    'div',
    {
      style: S.progressTrack,
      role: 'progressbar',
      'aria-valuenow': percent,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
    },
    h('div', { style: { ...S.progressFill, width: `${percent}%` } }),
  )
}

function quotaRow(balance: BillingBalance, t: (key: ZcodeLocaleKey) => string): unknown {
  const percent = sharePercent(balance.remainingUnits, balance.totalUnits)
  const expiry = formatTimestamp(balance.expiresAt)
  return h(
    'div',
    { style: S.quotaRow },
    h(
      'div',
      { style: S.quotaHead },
      h('span', { style: S.quotaName }, balance.showName ?? t('card.quota.unknown')),
      h(
        'span',
        { style: S.quotaAmount, title: `${t('card.quota.remaining')} / ${t('card.quota.total')}` },
        `${formatUnits(balance.remainingUnits, t)} / ${formatUnits(balance.totalUnits, t)}`,
      ),
    ),
    percent === null ? null : progressBar(percent),
    expiry === undefined ? null : h('span', { style: S.note }, `${t('card.quota.expires')} ${expiry}`),
  )
}

function planBlock(plan: BillingPlan, t: (key: ZcodeLocaleKey) => string): unknown {
  const start = formatTimestamp(plan.startsAt) ?? t('card.placeholder')
  const end = formatTimestamp(plan.endsAt) ?? t('card.placeholder')
  return h(
    'div',
    { style: S.planBlock },
    h(
      'div',
      { style: S.quotaHead },
      h('span', { style: S.quotaName }, plan.name ?? t('card.plans.unknown')),
      h('span', { style: S.badge }, plan.status ?? t('card.placeholder')),
    ),
    h('span', { style: S.note }, `${t('card.plans.period')} ${start} – ${end}`),
    ...plan.entitlements.map(entitlement =>
      h(
        'div',
        { style: S.entitlement },
        h(
          'span',
          { style: S.label },
          entitlement.showName ?? t('card.quota.unknown'),
        ),
        h(
          'span',
          { style: S.value },
          `${formatUnits(entitlement.grantUnits, t)}${entitlement.unitType === null ? '' : ` ${entitlement.unitType}`}${entitlement.period === null ? '' : ` · ${entitlement.period}`}`,
        ),
      ),
    ),
  )
}

/**
 * The two billing blocks, above the static mirror.
 *
 * Kept outside the component so the component body stays a single-exit body
 * with only hook calls at its top (see the discipline note below).
 */
function billingPanels(
  t: (key: ZcodeLocaleKey) => string,
  view: BillingView,
  reload: () => void,
): readonly unknown[] {
  if (view.status === 'loading') {
    return [
      section(t('card.quota.title'), [h('span', { style: S.note }, t('card.billing.loading'))]),
    ]
  }
  if (view.status === 'failed') {
    const reason = FAILURE_REASON[view.code] ?? 'card.billing.error.unknown'
    return [
      section(t('card.quota.title'), [
        h('span', { style: S.errorText }, `${t('card.billing.failed')} · ${view.code}`),
        h('span', { style: S.note }, t(reason)),
        view.message.length === 0 ? null : h('span', { style: S.mono }, view.message),
        h('button', { type: 'button', onClick: reload, style: S.retry }, t('card.billing.retry')),
      ]),
    ]
  }
  const { snapshot } = view
  const quotaChildren: unknown[] = snapshot.balances.length === 0
    ? [h('span', { style: S.note }, t('card.quota.empty'))]
    : snapshot.balances.map(balance => quotaRow(balance, t))
  const planChildren: unknown[] = snapshot.plans.length === 0
    ? [h('span', { style: S.note }, t('card.plans.empty'))]
    : snapshot.plans.map(plan => planBlock(plan, t))
  const fetched = formatTimestamp(Math.round(snapshot.fetchedAt / 1000))
  return [
    section(t('card.quota.title'), [
      ...quotaChildren,
      fetched === undefined ? null : h('span', { style: S.note }, `${t('card.billing.updated')} ${fetched}`),
    ]),
    section(t('card.plans.title'), planChildren),
  ]
}

/**
 * The run-configuration block: channel, model and reasoning effort, each a
 * select that writes straight back to the state route.
 *
 * Layout mirrors the Antigravity card the user asked to copy: the editable
 * choices sit above the read-only quota/plan detail, so the panel answers
 * "what is it doing" before "what is left".
 */
function selectionPanel(
  t: (key: ZcodeLocaleKey) => string,
  view: SelectionView,
  select: (patch: Record<string, string>) => void,
): unknown[] {
  if (view.status === 'loading') {
    return [section(t('card.run.title'), [h('span', { style: S.note }, t('card.run.loading'))])]
  }
  if (view.status === 'failed') {
    return [
      section(t('card.run.title'), [
        h('span', { style: S.errorText }, t('card.run.failed')),
        h('span', { style: S.note }, view.code),
        view.message.length === 0 ? null : h('span', { style: S.mono }, view.message),
      ]),
    ]
  }
  const { state } = view
  const control = (
    label: ZcodeLocaleKey,
    key: 'channel' | 'model' | 'effort',
    current: string,
    options: readonly SelectionOption[],
  ): unknown => {
    const choices = options.length === 0
      ? [h('option', { key: current, value: current }, current)]
      : options.map(option => h(
        'option',
        {
          key: option.id,
          value: option.id,
          disabled: option.available === false,
          ...(option.available === false && option.reason !== undefined
            ? { title: `${option.label} · ${option.reason}` }
            : {}),
        },
        option.label,
      ))
    return h(
      'label',
      { style: S.control },
      h('span', { style: S.label }, t(label)),
      h(
        'select',
        {
          style: S.select,
          value: current,
          onChange: (event: { target?: { value?: unknown } }) => {
            const next = event.target?.value
            if (typeof next === 'string' && next !== current) select({ [key]: next })
          },
        },
        ...choices,
      ),
    )
  }
  return [
    section(t('card.run.title'), [
      control('card.run.channel', 'channel', state.channel, state.channels),
      control('card.run.model', 'model', state.model, state.models),
      control('card.run.effort', 'effort', state.effort, state.efforts),
      h('span', { style: S.note }, t('card.run.note')),
    ]),
  ]
}

export function apply(ctx: ClientContext): void {
  // `locale` is declared in `inject`, so cordis guarantees it here.
  const locale = ctx.locale
  ctx.effect(() => {
    const disposeZh = locale.register(NS, 'zh', zh)
    const disposeEn = locale.register(NS, 'en', en)
    return () => {
      disposeEn()
      disposeZh()
    }
  }, 'dsh-zcode-provider: locale dictionaries')

  const useTranslation = (): ((key: ZcodeLocaleKey) => string) => {
    const [, rerender] = useState(0)
    useEffect(() => locale.subscribe(() => rerender((revision) => revision + 1)), [])
    return locale.bind(NS) as (key: ZcodeLocaleKey) => string
  }

  /**
   * Quota state: one GET on mount, one per retry (`?refresh=1`), aborted on
   * unmount. The retry counter is the dependency, so React's own rules drive
   * the refresh — no timers, no polling, no request outside an effect.
   *
   * Hook discipline: this helper is defined above the component and only ever
   * called as the component's second hook, so its `useState`/`useEffect` pair
   * keeps a stable position in the card's hook order.
   */
  const useBilling = (): { view: BillingView; reload: () => void } => {
    const [view, setView] = useState<BillingView>({ status: 'loading' })
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
      const controller = new AbortController()
      let active = true
      setView({ status: 'loading' })
      requestBilling(attempt > 0, controller.signal)
        .then((next) => {
          if (active) setView(next)
        })
        .catch((error: unknown) => {
          if (!active || controller.signal.aborted) return
          setView({
            status: 'failed',
            code: 'ZCODE_BILLING_HTTP',
            message: error instanceof Error ? error.message : String(error),
          })
        })
      return () => {
        active = false
        controller.abort()
      }
    }, [attempt])
    return { view, reload: () => setAttempt(value => value + 1) }
  }

  /**
   * Run-configuration state: one GET on mount, plus one POST per select change.
   *
   * `request` doubles as the dependency: `seq` makes every write a distinct
   * dependency value even when the same option is picked twice, so the effect
   * re-runs without any timers or polling.
   */
  const useSelection = (): {
    view: SelectionView
    select: (patch: Record<string, string>) => void
  } => {
    const [view, setView] = useState<SelectionView>({ status: 'loading' })
    const [request, setRequest] = useState<{ patch: Record<string, string> | null; seq: number }>({
      patch: null,
      seq: 0,
    })
    useEffect(() => {
      const controller = new AbortController()
      let active = true
      const call = request.patch === null
        ? requestState(controller.signal)
        : writeSelection(request.patch, controller.signal)
      call
        .then((next) => {
          if (active) setView(next)
        })
        .catch((error: unknown) => {
          if (!active || controller.signal.aborted) return
          setView({
            status: 'failed',
            code: 'STATE_UNAVAILABLE',
            message: error instanceof Error ? error.message : String(error),
          })
        })
      return () => {
        active = false
        controller.abort()
      }
    }, [request])
    return {
      view,
      select: (patch: Record<string, string>) => {
        setRequest(previous => ({ patch, seq: previous.seq + 1 }))
      },
    }
  }

  /**
   * React hook discipline — do not move hooks below a conditional return.
   *
   * Every `useState` / `useEffect` / `useRef` this component needs must be
   * called at the very top of the body, before the first `return` and before
   * any `if (…) return …`. React matches hooks by call order: a hook that only
   * runs on one branch throws "Rendered more hooks than during the previous
   * render" on the next render, and the host's `SlotErrorBoundary` turns that
   * throw into an EMPTY element — the exact blank-row symptom this card exists
   * to remove. Hence: both hooks (`useTranslation`, then `useBilling`, which
   * owns the request state) first, and a single exit further down.
   * `tests/client.test.mjs` asserts the single-exit shape.
   */
  const ZcodeProviderCard = (props?: unknown): unknown => {
    const t = useTranslation()
    const billing = useBilling()
    const selection = useSelection()
    const configured = propBoolean(props, 'configured')
    const provider = propString(props, 'provider') ?? PROVIDER_ROUTE
    const badge =
      configured === undefined ? t('card.badge.unknown') : configured ? t('card.badge.on') : t('card.badge.off')

    const modelLine = MODELS.map((id, index) =>
      index === 0 ? `${id} (${t('card.models.default')})` : id,
    ).join(' · ')

    return h(
      'div',
      { 'data-zcode-provider-card': CARD_ID, style: S.card },
      h(
        'div',
        { style: S.header },
        h('span', { style: S.title }, t('card.title')),
        h('span', { style: S.badge, title: provider }, badge),
      ),
      ...selectionPanel(t, selection.view, selection.select),
      ...billingPanels(t, billing.view, billing.reload),
      h('div', { style: S.divider }),
      row(t('card.route'), provider, true),
      row(t('card.ns'), SETTINGS_NS, true),
      h('div', { style: S.divider }),
      section(t('card.models'), [row(t('card.models.catalog'), modelLine)]),
      section(t('card.defaults'), [
        row(t('card.defaults.model'), DEFAULT_MODEL, true),
        row(t('card.defaults.sessionMode'), t('card.defaults.sessionMode.value')),
        row(t('card.defaults.toolPolicy'), t('card.defaults.toolPolicy.value')),
        row(t('card.defaults.mode'), t('card.defaults.mode.value')),
        row(t('card.defaults.imageInput'), t('card.defaults.imageInput.value')),
        h('span', { style: S.note }, t('card.defaults.source')),
      ]),
      h('div', { style: S.divider }),
      section(t('card.cli'), [
        row(t('card.cli.node'), NODE_PATH, true),
        row(t('card.cli.cjs'), ZCODE_CJS_PATH, true),
      ]),
      section(t('card.env'), [
        h('span', { style: S.note }, t('card.env.hint')),
        ...ENV_CONTRACT.map(env =>
          h(
            'div',
            { style: S.section },
            h('span', { style: S.value }, h('span', { style: S.mono }, env.name), ` — ${t(env.descriptionKey)}`),
            h('span', { style: S.mono }, env.expected),
          ),
        ),
      ]),
      h('div', { style: S.divider }),
      h('span', { style: S.note }, t('card.quota')),
      h('span', { style: S.note }, t('card.billing.source')),
    )
  }

  // Keyed slot registration. The host matches `key` against the row's
  // `entryKey` (= `settingsNs` of the directory entry) character for character;
  // a typo here re-creates the empty row without any error anywhere.
  ctx.slots.inject('settings.models.provider-card', () => {
    return ctx.slots.register(
      {
        name: 'settings.models.provider-card',
        key: SETTINGS_NS,
        id: CARD_ID,
      },
      ZcodeProviderCard,
    )
  })
}
