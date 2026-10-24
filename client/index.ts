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
 * Scope: a read-only information panel. `src/` ships no `web/router.ts`, so the
 * card never fetches anything; every value is either a compile-time mirror of
 * the Node half or read out of the slot props the host does pass —
 * `{ provider, configured, keyConfigured }` (app.asar ModelsSection,
 * `renderSlot('settings.models.provider-card', {provider, configured,
 * keyConfigured}, {entryKey})`). Nothing here can throw on a missing prop: the
 * host wraps each slot entry in `SlotErrorBoundary`, which renders an empty
 * element on a throw — a card that crashes looks exactly like the empty row
 * this file is fixing.
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
   * React hook discipline — do not move hooks below a conditional return.
   *
   * Every `useState` / `useEffect` / `useRef` this component needs must be
   * called at the very top of the body, before the first `return` and before
   * any `if (…) return …`. React matches hooks by call order: a hook that only
   * runs on one branch throws "Rendered more hooks than during the previous
   * render" on the next render, and the host's `SlotErrorBoundary` turns that
   * throw into an EMPTY element — the exact blank-row symptom this card exists
   * to remove. Hence: one hook call (`useTranslation`, which owns the only
   * `useState`/`useEffect` pair), first line of the body, and a single exit
   * further down. `tests/client.test.mjs` asserts the single-exit shape.
   */
  const ZcodeProviderCard = (props?: unknown): unknown => {
    const t = useTranslation()
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
      h('span', { style: S.note }, t('card.noRoute')),
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
