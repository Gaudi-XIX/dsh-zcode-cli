/**
 * Local HTTP surface of the quota panel.
 *
 * The card on the Models page cannot reach the plan endpoint itself: the token
 * lives in the ZCode credential store and must never reach the renderer. This
 * router is the only bridge — one loopback GET that returns the normalised
 * snapshot, or a classified failure the card can explain.
 *
 * Rules of the surface:
 * - Loopback only. The route is exact and unauthenticated, so a non-local peer
 *   is rejected before any credential is read.
 * - Fail closed, never throw: a broken read becomes `{ ok: false, error }`, and
 *   a broken carrier (no web server, refused registration) leaves the plugin
 *   otherwise intact.
 * - No secrets in the response. Messages come from `ZcodeError.message`, which
 *   this module keeps free of tokens; anything else is sanitized and bounded.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import { DEFAULT_MODELS } from '../provider/config.js'
import { isZcodeError, sanitizeSecrets } from '../provider/error-codes.js'
import {
  BillingError,
  createBillingReader,
  createQuotaReader,
  type BillingReader,
  type QuotaReader,
  type ZcodeBillingSnapshot,
  type ZcodeQuotaSnapshot,
} from '../zcode/billing.js'

/** Exact path the card fetches. Kept in one place so the client mirrors it. */
export const BILLING_ROUTE_PATH = '/plugins/zcode-provider/billing'

/** The slice of a DSH web server this module uses. */
export interface DshWebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Options of {@link setupBillingRoutes}; `reader` exists for the tests. */
export interface BillingRouteOptions {
  readonly reader?: BillingReader
}

interface BillingErrorBody {
  readonly code: string
  readonly message: string
}

type BillingResponse =
  | { readonly ok: true; readonly data: ZcodeBillingSnapshot }
  | { readonly ok: false; readonly error: BillingErrorBody }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res: ServerResponse, status: number, body: BillingResponse): void {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text, 'utf8')),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** Turn any thrown value into the envelope's error shape, without its secrets. */
function toErrorBody(error: unknown): BillingErrorBody {
  if (isZcodeError(error)) return { code: error.code, message: sanitizeSecrets(error.message) }
  return { code: 'ZCODE_BILLING_HTTP', message: sanitizeSecrets(describe(error)) }
}

/**
 * Build the route handler.
 *
 * Exported separately so the tests can drive it with a stub reader and a plain
 * request/response pair, without a host or a network.
 */
export function createBillingHttpHandler(
  reader: BillingReader,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } })
        return
      }
      if (!isLoopbackPeer(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'The billing endpoint is loopback-only' } })
        return
      }
      const url = new URL(req.url ?? BILLING_ROUTE_PATH, 'http://127.0.0.1')
      const force = url.searchParams.get('refresh') === '1'
      try {
        sendJson(res, 200, { ok: true, data: await reader.read({ force }) })
      } catch (error) {
        // A failed read is data, not a crash: the card shows code + reason and
        // offers 继续读取 (force). HTTP status stays 200 so the browser-side
        // `response.ok` check does not hide the classified error behind a
        // generic network failure.
        sendJson(res, 200, { ok: false, error: toErrorBody(error) })
      }
    } catch {
      // The peer vanished mid-request or `res` is already closed. There is
      // nothing left to report to; ending quietly is the only safe action.
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          // Double close: nothing to do.
        }
      }
    }
  }
}

/**
 * Mount the billing route on the host web server.
 *
 * `ctx.inject` is what keeps a profile without a web server bootable: the
 * callback simply never runs. Registration failures are swallowed for the same
 * reason — the quota panel is an addition, and losing it must not cost the
 * provider row.
 *
 * @returns disposer for the registered route (no-op when nothing was mounted).
 */
export function setupBillingRoutes(ctx: Context, options: BillingRouteOptions = {}): () => void {
  const disposers: Array<() => void> = []
  ctx.inject(['webServer'], (innerCtx) => {
    const webServer = (innerCtx as unknown as { webServer?: DshWebServerLike }).webServer
    if (webServer === undefined || typeof webServer.register !== 'function') return
    const reader = options.reader ?? createBillingReader({
      fetch: globalThis.fetch.bind(globalThis),
      now: () => Date.now(),
      env: process.env,
    })
    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: BILLING_ROUTE_PATH,
        handler: createBillingHttpHandler(reader),
      }))
    } catch {
      // A duplicate path or a refused kind costs the panel, not the provider.
    }
  })
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // The host already tore the route down.
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * A2 surface: the settings-page contract.
 *
 * Three exact routes under the plugin's own namespace: read the current
 * selection, write a partial selection, read the quota snapshot. They coexist
 * with {@link setupBillingRoutes} above — that one is already wired into
 * `src/index.ts` and serves the existing card, so it is kept untouched.
 *
 * The handler never throws: the host turns a throwing handler into a bare 400
 * with an empty body, which is the least useful answer for a card that has to
 * explain why the quota panel is empty.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Exact path of the selection route (GET + POST). */
export const ZCODE_STATE_ROUTE_PATH = '/plugins/dsh-zcode-provider/state'
/** Exact path of the quota route (GET). */
export const ZCODE_QUOTA_ROUTE_PATH = '/plugins/dsh-zcode-provider/quota'
/**
 * Host-side diagnostic route. Loopback-only, read-only, and mounted only when
 * the caller injects a probe: it exists to answer questions only the host
 * process can answer (why the model picker hides this provider, whether the
 * browser half reached `window.__DSH_BOOT__`).
 */
export const ZCODE_DIAG_ROUTE_PATH = '/plugins/dsh-zcode-provider/diag'

/** Effort ids the host accepts on this route. Frozen with the card. */
export const ZCODE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** One effort option as the card renders it. */
export type ZcodeEffortId = typeof ZCODE_EFFORTS[number]

/** Channels the plugin can route a turn through. Frozen with the card. */
export const ZCODE_CHANNELS = [
  { id: 'free', label: 'ZCode 免费额度通道' },
  { id: 'paid', label: '智谱付费通道' },
  { id: 'cli', label: '官方 CLI 子进程' },
] as const
/** One channel id. */
export type ZcodeChannelId = typeof ZCODE_CHANNELS[number]['id']

/** The selection this route reads and writes. */
export interface ZcodeSelection {
  readonly channel: string
  readonly model: string
  readonly effort: string
}

/** A partial write; only the keys present are changed. */
export interface ZcodeSelectionPatch {
  readonly channel?: string
  readonly model?: string
  readonly effort?: string
}

/**
 * Everything {@link createZcodeWebRoutes} touches.
 *
 * `setSelection` is the plugin's own setter (see the handoff): it must persist
 * the selection in the DSH settings namespace, never in a ZCode config file.
 * `dataBaseDir` is the ZCode *data* root, the directory that contains
 * `.zcode/v2/`.
 */
export interface ZcodeWebRoutesDeps {
  getConfig(): ZcodeSelection
  setSelection(patch: ZcodeSelectionPatch): Promise<void>
  readonly dataBaseDir: string
  /** Injected for the tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Injected for the tests; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>
  /** Injected for the tests; defaults to `Date.now`. */
  readonly now?: () => number
  /** Injected for the tests; defaults to a 30-second reader. */
  readonly quotaReader?: QuotaReader
  /**
   * Optional host-side probe. The provider row can be correct while the model
   * picker still hides the provider (the host drops a group whose model
   * resolution throws), so the only place that can answer "why" is the host
   * process itself. Absent in production until a caller wires it.
   */
  readonly probe?: () => Promise<unknown>
}

/** The slice of the host web server this module uses. */
export interface ZcodeWebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** One quota row after entitlements and balances are aligned by model id. */
export interface ZcodeMergedQuota {
  readonly modelId: string
  readonly grantUnits: number | null
  readonly usedUnits: number | null
  readonly remainingUnits: number | null
  /** `used / (used + remaining)`, or `used / grant` when no pool row exists. */
  readonly percentUsed: number | null
}

/** Options bag for {@link createZcodeWebRoutes}; empty today, kept explicit. */
export interface ZcodeWebRoutesOptions {
  readonly now?: () => number
}

/** The mounted route set. */
export interface ZcodeWebRoutes {
  /** Register the three routes on the host carrier; returns a disposer. */
  register(server: ZcodeWebServerLike): () => void
}

/** The state payload, in the exact shape the card expects. */
export interface ZcodeStatePayload {
  readonly channel: string
  readonly model: string
  readonly effort: string
  readonly models: readonly { readonly id: string; readonly label: string }[]
  readonly efforts: readonly { readonly id: string; readonly label: string }[]
  readonly channels: readonly {
    readonly id: string
    readonly label: string
    readonly available: boolean
    readonly reason?: string
  }[]
}

const MAX_SELECTION_BODY_BYTES = 16 * 1024

function sendRouteJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text, 'utf8')),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read a JSON object body, bounded.
 *
 * A body that is not a JSON object resolves to `undefined`; the caller decides
 * whether that is `INVALID_BODY` (POST) or irrelevant (GET).
 */
function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: Record<string, unknown> | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_SELECTION_BODY_BYTES) {
        req.destroy()
        finish(undefined)
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (size === 0) {
        finish({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined)
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

/** Build the state payload. `getConfig` failures are the caller's problem. */
function buildState(deps: ZcodeWebRoutesDeps): ZcodeStatePayload {
  const config = deps.getConfig()
  return {
    channel: config.channel,
    model: config.model,
    effort: config.effort,
    models: DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.name ?? model.id })),
    efforts: ZCODE_EFFORTS.map((id) => ({ id, label: id === 'xhigh' ? 'X-High' : `${id[0]!.toUpperCase()}${id.slice(1)}` })),
    channels: ZCODE_CHANNELS.map((channel) => ({ id: channel.id, label: channel.label, available: true })),
  }
}

/**
 * Validate one POST body.
 *
 * @returns the patch to apply, or the machine-readable rejection code.
 */
function validateSelectionPatch(
  body: Record<string, unknown>,
): { readonly patch: ZcodeSelectionPatch } | { readonly error: string } {
  const allowed = new Set(['channel', 'model', 'effort'])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { error: 'UNKNOWN_FIELD' }
  }

  const patch: { channel?: string; model?: string; effort?: string } = {}
  const channel = body['channel']
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !ZCODE_CHANNELS.some((entry) => entry.id === channel)) {
      return { error: 'INVALID_CHANNEL' }
    }
    patch.channel = channel
  }
  const model = body['model']
  if (model !== undefined) {
    if (typeof model !== 'string' || !DEFAULT_MODELS.some((entry) => entry.id === model)) {
      return { error: 'INVALID_MODEL' }
    }
    patch.model = model
  }
  const effort = body['effort']
  if (effort !== undefined) {
    if (typeof effort !== 'string' || !(ZCODE_EFFORTS as readonly string[]).includes(effort)) {
      return { error: 'INVALID_EFFORT' }
    }
    patch.effort = effort
  }
  return { patch }
}

/** HTTP status for a classified quota failure: local capability vs upstream. */
function quotaFailureStatus(code: string): number {
  switch (code) {
    case 'ZCODE_CREDENTIAL_MISSING':
    case 'ZCODE_CREDENTIAL_INVALID':
    case 'ZCODE_CREDENTIAL_DECRYPT_FAILED':
    case 'ZCODE_ENV_MISSING':
    case 'ZCODE_BILLING_UNAUTHORIZED':
    case 'ZCODE_BILLING_BAD_REQUEST':
      return 503
    default:
      return 502
  }
}

/** Turn any thrown value into the quota envelope's failure arm. */
function toQuotaFailure(error: unknown): { readonly ok: false; readonly error: string; readonly detail: string } {
  if (isZcodeError(error)) {
    const snippet = error instanceof BillingError ? error.bodySnippet : undefined
    const detail = [error.message, snippet]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' | ')
    return { ok: false, error: error.code, detail: sanitizeSecrets(detail) }
  }
  return { ok: false, error: 'ZCODE_BILLING_HTTP', detail: sanitizeSecrets(describe(error)) }
}

/** Align entitlements and balances by model id. Exported for the tests. */
export function mergeQuotaSnapshot(snapshot: ZcodeQuotaSnapshot): readonly ZcodeMergedQuota[] {
  const balances = new Map<string, { readonly usedUnits: number | null; readonly remainingUnits: number | null }>()
  for (const balance of snapshot.balances) balances.set(balance.modelId, balance)

  const merged: ZcodeMergedQuota[] = []
  const seen = new Set<string>()
  const add = (modelId: string, grantUnits: number | null): void => {
    if (seen.has(modelId)) return
    seen.add(modelId)
    const balance = balances.get(modelId)
    const usedUnits = balance?.usedUnits ?? null
    const remainingUnits = balance?.remainingUnits ?? null
    const pool = usedUnits !== null && remainingUnits !== null ? usedUnits + remainingUnits : null
    const total = pool ?? grantUnits
    const percentUsed = usedUnits !== null && total !== null && total > 0
      ? Math.round((usedUnits / total) * 10_000) / 100
      : null
    merged.push({ modelId, grantUnits, usedUnits, remainingUnits, percentUsed })
  }

  for (const plan of snapshot.plans) {
    for (const entitlement of plan.entitlements) add(entitlement.modelId, entitlement.grantUnits)
  }
  // A balance without a matching entitlement is still real consumption; show
  // the row with `grantUnits: null` instead of hiding the model entirely.
  for (const balance of snapshot.balances) add(balance.modelId, null)
  return merged
}

/**
 * Build the settings-page route set.
 *
 * @param deps - selection accessors, the ZCode data root, and test seams.
 * @returns a register/dispose pair; nothing is mounted until `register` runs.
 */
export function createZcodeWebRoutes(deps: ZcodeWebRoutesDeps): ZcodeWebRoutes {
  const reader: QuotaReader = deps.quotaReader ?? createQuotaReader({
    dataBaseDir: deps.dataBaseDir,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch.bind(globalThis),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })

  const stateHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      sendRouteJson(res, 403, { ok: false, error: 'FORBIDDEN' })
      return
    }
    if (req.method === 'GET') {
      try {
        // Same envelope as POST: the card parses one shape for both verbs, so a
        // flat GET body would read as STATE_UNAVAILABLE and blank the controls.
        sendRouteJson(res, 200, { ok: true, state: buildState(deps) })
      } catch (error) {
        sendRouteJson(res, 500, { ok: false, error: 'STATE_UNAVAILABLE', detail: sanitizeSecrets(describe(error)) })
      }
      return
    }
    if (req.method !== 'POST') {
      sendRouteJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
      return
    }

    const body = await readJsonObject(req)
    if (body === undefined) {
      sendRouteJson(res, 400, { ok: false, error: 'INVALID_BODY' })
      return
    }
    const validated = validateSelectionPatch(body)
    if ('error' in validated) {
      sendRouteJson(res, 400, { ok: false, error: validated.error })
      return
    }
    if (Object.keys(validated.patch).length > 0) {
      try {
        await deps.setSelection(validated.patch)
      } catch (error) {
        sendRouteJson(res, 500, { ok: false, error: 'SET_FAILED', detail: sanitizeSecrets(describe(error)) })
        return
      }
    }
    try {
      sendRouteJson(res, 200, { ok: true, state: buildState(deps) })
    } catch (error) {
      sendRouteJson(res, 500, { ok: false, error: 'STATE_UNAVAILABLE', detail: sanitizeSecrets(describe(error)) })
    }
  }

  const quotaHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      sendRouteJson(res, 403, { ok: false, error: 'FORBIDDEN' })
      return
    }
    if (req.method !== 'GET') {
      sendRouteJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
      return
    }
    const url = new URL(req.url ?? ZCODE_QUOTA_ROUTE_PATH, 'http://127.0.0.1')
    const refresh = url.searchParams.get('refresh') === '1'
    try {
      const quota = await reader.read({ refresh })
      sendRouteJson(res, 200, { ok: true, quota, merged: mergeQuotaSnapshot(quota) })
    } catch (error) {
      const failure = toQuotaFailure(error)
      sendRouteJson(res, quotaFailureStatus(failure.error), failure)
    }
  }

  const probeHandler = deps.probe === undefined
    ? undefined
    : async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isLoopbackRequest(req)) {
        sendRouteJson(res, 403, { ok: false, error: 'FORBIDDEN' })
        return
      }
      if (req.method !== 'GET') {
        sendRouteJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
        return
      }
      try {
        const probe = deps.probe
        sendRouteJson(res, 200, { ok: true, probe: await probe!() })
      } catch (error) {
        sendRouteJson(res, 500, { ok: false, error: 'PROBE_FAILED', detail: sanitizeSecrets(describe(error)) })
      }
    }

  return {
    register(server: ZcodeWebServerLike): () => void {
      if (server === null || server === undefined || typeof server.register !== 'function') return () => {}
      const disposers: Array<() => void> = []
      const routes: ReadonlyArray<readonly [string, (req: IncomingMessage, res: ServerResponse) => Promise<void>]> = [
        [ZCODE_STATE_ROUTE_PATH, stateHandler],
        [ZCODE_QUOTA_ROUTE_PATH, quotaHandler],
        ...(probeHandler === undefined ? [] : [[ZCODE_DIAG_ROUTE_PATH, probeHandler]] as const),
      ]
      for (const [path, handler] of routes) {
        try {
          const dispose = server.register({ kind: 'exact', path, handler })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch {
          // A refused route costs the panel, never the provider row.
        }
      }
      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            // The host already tore the route down.
          }
        }
      }
    },
  }
}
