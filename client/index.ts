/**
 * Browser half of the ZCode provider: the card the host renders inside the
 * provider row on 设置 → 模型.
 *
 * Why it exists: the Node half registers the directory entry
 * (`ctx.llm.registerConfigurableProviders`, `settingsNs: 'dsh-zcode-cli'`
 * in `src/index.ts`), and the host then renders that row's body by dispatching
 * the keyed slot `settings.models.provider-card` for the entry whose registered
 * `key` equals the row's `settingsNs` **verbatim**. With no client half there is
 * no entry under that key, and the host does not fall back to a generic form —
 * the row body stays empty. This file is that entry.
 *
 * Scope: a run-configuration block (plan, model, reasoning effort) plus a
 * read-only information panel. The run-configuration block reads and writes the
 * plugin's own loopback route (`GET`/`POST /plugins/dsh-zcode-cli/state`,
 * mounted by `src/web/router.ts`). Everything below the divider is a
 * compile-time mirror of the Node half or a value read out of the
 * slot props the host does pass — `{ provider, configured, keyConfigured }`
 * (app.asar ModelsSection, `renderSlot('settings.models.provider-card',
 * {provider, configured, keyConfigured}, {entryKey})`). Nothing here can throw
 * on a missing prop: the host wraps each slot entry in `SlotErrorBoundary`,
 * which renders an empty element on a throw — a card that crashes looks exactly
 * like the empty row this file is fixing.
 */

import type { Context } from '@deepseek-ai/cordis'

import { en, NS, zh, type ZcodeLocaleKey } from './locales.js'
import { ZC_CSS } from './styles.js'

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

export const name = 'dsh-zcode-cli-client'

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
const SETTINGS_NS = 'dsh-zcode-cli'
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
/** MUST equal `ZCODE_STATE_ROUTE_PATH` in `src/web/router.ts`. */
const STATE_PATH = '/plugins/dsh-zcode-cli/state'

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

/** Narrow an unknown payload to a plain object. */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Read a non-empty string field. */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Read the option list of a select, dropping entries the host cannot use. */
function readOptions(value: unknown): readonly SelectionOption[] {
  if (!Array.isArray(value)) return []
  const options: SelectionOption[] = []
  for (const entry of value) {
    const record = recordOf(entry)
    if (record === null) continue
    const id = readString(record['id'])
    const label = readString(record['label'])
    if (id === null || label === null) continue
    const available = typeof record['available'] === 'boolean' ? (record['available'] as boolean) : undefined
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

/** Read a boolean prop; `undefined` means "the host did not say". */
function propBoolean(props: unknown, key: string): boolean | undefined {
  if (props === null || typeof props !== 'object') return undefined
  const value = (props as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

interface SelectionOption {
  readonly id: string
  readonly label: string
  readonly available?: boolean
  readonly reason?: string
}

interface SelectionState {
  readonly plan: string
  readonly model: string
  readonly effort: string
  readonly plans: readonly SelectionOption[]
  readonly models: readonly SelectionOption[]
  readonly efforts: readonly SelectionOption[]
}

type SelectionView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }
  | { readonly status: 'ready'; readonly state: SelectionState }

function readSelectionEnvelope(record: Record<string, unknown>): SelectionView {
  if (record['ok'] !== true) return { status: 'failed', code: 'STATE_UNAVAILABLE', message: '' }
  const state = recordOf(record['state'])
  if (state === null) return { status: 'failed', code: 'STATE_UNAVAILABLE', message: '' }
  const plan = readString(state['plan'])
  const model = readString(state['model'])
  const effort = readString(state['effort'])
  if (plan === null || model === null || effort === null) {
    return { status: 'failed', code: 'STATE_INCOMPLETE', message: '' }
  }
  return {
    status: 'ready',
    state: {
      plan,
      model,
      effort,
      plans: readOptions(state['plans']),
      models: readOptions(state['models']),
      efforts: readOptions(state['efforts']),
    },
  }
}

async function requestState(signal?: AbortSignal): Promise<SelectionView> {
  const response = await fetch(STATE_PATH, { headers: { Accept: 'application/json' }, ...(signal === undefined ? {} : { signal }) })
  const body = await response.json().catch(() => null)
  const record = recordOf(body)
  if (record === null) return { status: 'failed', code: 'STATE_UNREADABLE', message: '' }
  return readSelectionEnvelope(record)
}

async function writeSelection(patch: Record<string, string>, signal?: AbortSignal): Promise<SelectionView> {
  const response = await fetch(STATE_PATH, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(signal === undefined ? {} : { signal }),
    body: JSON.stringify(patch),
  })
  const body = await response.json().catch(() => null)
  const record = recordOf(body)
  if (record === null) {
    return { status: 'failed', code: 'STATE_UNREADABLE', message: '' }
  }
  if (record['ok'] !== true) {
    const error = recordOf(record['error'])
    const code = error === null ? null : readString(error['code'])
    return {
      status: 'failed',
      code: code ?? 'STATE_REJECTED',
      message: error === null ? '' : (readString(error['message']) ?? ''),
    }
  }
  return readSelectionEnvelope(record)
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

/**
 * A titled block the user can fold away. Native `<details>`/`<summary>`:
 * zero React state (the card's hooks-order contract stays untouched) and the
 * open/closed state lives in the DOM, so it survives host re-renders.
 */
function fold(title: string, children: readonly unknown[], open = false): unknown {
  return h(
    'details',
    { className: 'zc-fold', open },
    h('summary', null, title),
    h('div', { className: 'zc-fold-body' }, ...children),
  )
}

/**
 * The DOM slice the bulk switch touches. Typed structurally on purpose: this
 * project's client tsconfig carries only `lib: ES2022` plus Node's types, so
 * there is no DOM lib here and `HTMLDetailsElement` would not compile.
 */
interface FoldElement {
  open: boolean
}

interface FoldGroup {
  querySelectorAll(selector: string): ArrayLike<FoldElement>
}

/** Walk up from the clicked switch to the group that owns the folds. */
function foldGroupOf(target: unknown): FoldGroup | null {
  if (target === null || typeof target !== 'object') return null
  const closest = (target as { closest?: unknown }).closest
  if (typeof closest !== 'function') return null
  const group = closest.call(target, '.zc-fold-group')
  if (group === null || typeof group !== 'object') return null
  const query = (group as { querySelectorAll?: unknown }).querySelectorAll
  return typeof query === 'function' ? (group as FoldGroup) : null
}

/**
 * One switch for all four read-only blocks: expand everything that is still
 * closed, otherwise collapse everything.
 *
 * The live `open` flags are the only source of truth — mirroring them into
 * React state would (a) add a hook to a component whose hooks order is pinned
 * by a test, and (b) let the switch lie after the user clicks one title alone.
 */
function toggleFolds(target: unknown): void {
  const group = foldGroupOf(target)
  if (group === null) return
  const folds = Array.from(group.querySelectorAll('details.zc-fold'))
  const next = !folds.every(node => node.open)
  for (const node of folds) node.open = next
}

/**
 * The four read-only blocks plus their bulk switch.
 *
 * `<details>` owns its own state in the DOM, so the switch only has to find the
 * group and write `open` on each block: no hook, no ref, and the card's
 * single-exit / hooks-order contract stays exactly as it was.
 *
 * The switch label is chosen by CSS (`:has()` on the group), not by JS, so it
 * stays true even when the user opens the blocks one at a time.
 */
function foldGroup(t: (key: ZcodeLocaleKey) => string, children: readonly unknown[]): unknown {
  return h(
    'div',
    { className: 'zc-fold-group' },
    h(
      'div',
      { className: 'zc-fold-bar' },
      h(
        'button',
        {
          type: 'button',
          className: 'zc-fold-switch',
          onClick: (event: { currentTarget?: unknown }) => toggleFolds(event.currentTarget),
        },
        h('span', { className: 'zc-fold-expand' }, t('card.fold.expandAll')),
        h('span', { className: 'zc-fold-collapse' }, t('card.fold.collapseAll')),
      ),
    ),
    ...children,
  )
}

/**
 * The run-configuration block: plan, model and reasoning effort, each a
 * select that writes straight back to the state route.
 *
 * Layout mirrors the Antigravity card the user asked to copy: the editable
 * choices sit at the top, so the panel answers "what is it doing" before the
 * read-only mirrors below.
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
    key: 'plan' | 'model' | 'effort',
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
          className: 'zc-select',
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
      control('card.run.plan', 'plan', state.plan, state.plans),
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
  }, 'dsh-zcode-cli: locale dictionaries')

  const useTranslation = (): ((key: ZcodeLocaleKey) => string) => {
    const [, rerender] = useState(0)
    useEffect(() => locale.subscribe(() => rerender((revision) => revision + 1)), [])
    return locale.bind(NS) as (key: ZcodeLocaleKey) => string
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
   * to remove. Hence: both hooks (`useTranslation`, then `useSelection`, which
   * owns the request state) first, and a single exit further down.
   * `tests/client.test.mjs` asserts the single-exit shape.
   */
  const ZcodeProviderCard = (props?: unknown): unknown => {
    const t = useTranslation()
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
      h('style', null, ZC_CSS),
      h(
        'div',
        { style: S.header },
        h('span', { style: S.title }, t('card.title')),
        h('span', { style: S.badge, title: provider }, badge),
      ),
      ...selectionPanel(t, selection.view, selection.select),
      h('div', { style: S.divider }),
      row(t('card.route'), provider, true),
      row(t('card.ns'), SETTINGS_NS, true),
      h('div', { style: S.divider }),
      foldGroup(t, [
        fold(t('card.models'), [row(t('card.models.catalog'), modelLine)]),
        fold(t('card.defaults'), [
          row(t('card.defaults.model'), DEFAULT_MODEL, true),
          row(t('card.defaults.sessionMode'), t('card.defaults.sessionMode.value')),
          row(t('card.defaults.toolPolicy'), t('card.defaults.toolPolicy.value')),
          row(t('card.defaults.mode'), t('card.defaults.mode.value')),
          row(t('card.defaults.imageInput'), t('card.defaults.imageInput.value')),
          h('span', { style: S.note }, t('card.defaults.source')),
        ]),
        h('div', { style: S.divider }),
        fold(t('card.cli'), [
          row(t('card.cli.node'), NODE_PATH, true),
          row(t('card.cli.cjs'), ZCODE_CJS_PATH, true),
        ]),
        fold(t('card.env'), [
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
      ]),
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
