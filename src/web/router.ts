/**
 * Local HTTP surface of the settings card.
 *
 * The card on the Models page lives in the renderer, but the selection it shows
 * and writes belongs to the Node half: this router is the only bridge. Two
 * exact routes under the plugin's own namespace: read the current selection
 * (GET) and write a partial selection (POST).
 *
 * Rules of the surface:
 * - Loopback only. The routes are exact and unauthenticated, so a non-local peer
 *   is rejected before anything is read or written.
 * - Fail closed, never throw: a broken read or write becomes
 *   `{ ok: false, error }`, and a broken carrier (no web server, refused
 *   registration) leaves the plugin otherwise intact.
 * - No secrets in the response. Messages come from `ZcodeError.message`, which
 *   this module keeps free of tokens; anything else is sanitized and bounded.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { DEFAULT_MODELS } from '../provider/config.js'
import { sanitizeSecrets } from '../provider/error-codes.js'

/** Exact path of the selection route (GET + POST). */
export const ZCODE_STATE_ROUTE_PATH = '/plugins/dsh-zcode-provider/state'
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

/** Plans the card offers. Transport is always the official CLI subprocess. */
export const ZCODE_PLANS = [
  { id: 'free', label: '免费套餐', labelEn: 'Free start plan' },
  { id: 'paid', label: '付费套餐', labelEn: 'Paid coding plan' },
] as const
/** One plan id. */
export type ZcodePlanId = typeof ZCODE_PLANS[number]['id']

/** The selection this route reads and writes. */
export interface ZcodeSelection {
  readonly plan: string
  readonly model: string
  readonly effort: string
}

/** A partial write; only the keys present are changed. */
export interface ZcodeSelectionPatch {
  readonly plan?: string
  readonly model?: string
  readonly effort?: string
}

/**
 * Everything {@link createZcodeWebRoutes} touches.
 *
 * `setSelection` is the plugin's own setter (see the handoff): it must persist
 * the selection in the DSH settings namespace, never in a ZCode config file.
 */
export interface ZcodeWebRoutesDeps {
  getConfig(): ZcodeSelection
  setSelection(patch: ZcodeSelectionPatch): Promise<void>
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

/** The mounted route set. */
export interface ZcodeWebRoutes {
  /** Register the routes on the host carrier; returns a disposer. */
  register(server: ZcodeWebServerLike): () => void
}

/** The state payload, in the exact shape the card expects. */
export interface ZcodeStatePayload {
  readonly plan: string
  readonly model: string
  readonly effort: string
  readonly plans: readonly { readonly id: string; readonly label: string; readonly labelEn: string }[]
  readonly models: readonly { readonly id: string; readonly label: string }[]
  readonly efforts: readonly { readonly id: string; readonly label: string }[]
}

const MAX_SELECTION_BODY_BYTES = 16 * 1024

function sendRouteJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(body)
  // A peer that hung up mid-request (the bounded body reader destroys the
  // socket) turns a write into a late 'error' on this response; without a
  // listener that becomes an uncaught exception in the host process.
  res.once('error', () => {})
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(text, 'utf8')),
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch {
    // The connection is gone; there is no one left to answer.
  }
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeDetail(text: string): string {
  return sanitizeSecrets(text)
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
    plan: config.plan,
    model: config.model,
    effort: config.effort,
    plans: ZCODE_PLANS.map((plan) => ({ id: plan.id, label: plan.label, labelEn: plan.labelEn })),
    models: DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.name ?? model.id })),
    efforts: ZCODE_EFFORTS.map((id) => ({ id, label: id === 'xhigh' ? 'X-High' : `${id[0]!.toUpperCase()}${id.slice(1)}` })),
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
  const allowed = new Set(['plan', 'model', 'effort'])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { error: 'UNKNOWN_FIELD' }
  }

  const patch: { plan?: string; model?: string; effort?: string } = {}
  const plan = body['plan']
  if (plan !== undefined) {
    if (typeof plan !== 'string' || !ZCODE_PLANS.some((entry) => entry.id === plan)) {
      return { error: 'INVALID_SELECTION' }
    }
    patch.plan = plan
  }
  const model = body['model']
  if (model !== undefined) {
    if (typeof model !== 'string' || !DEFAULT_MODELS.some((entry) => entry.id === model)) {
      return { error: 'INVALID_SELECTION' }
    }
    patch.model = model
  }
  const effort = body['effort']
  if (effort !== undefined) {
    if (typeof effort !== 'string' || !(ZCODE_EFFORTS as readonly string[]).includes(effort)) {
      return { error: 'INVALID_SELECTION' }
    }
    patch.effort = effort
  }
  return { patch }
}

/**
 * Build the settings-page route set.
 *
 * @param deps - selection accessors and an optional host probe.
 * @returns a register/dispose pair; nothing is mounted until `register` runs.
 */
export function createZcodeWebRoutes(deps: ZcodeWebRoutesDeps): ZcodeWebRoutes {
  const stateHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      sendRouteJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'This endpoint is loopback-only' } })
      return
    }
    if (req.method === 'GET') {
      try {
        // Same envelope as POST: the card parses one shape for both verbs, so a
        // flat GET body would read as STATE_UNAVAILABLE and blank the controls.
        sendRouteJson(res, 200, { ok: true, state: buildState(deps), error: null })
      } catch (error) {
        sendRouteJson(res, 500, { ok: false, error: { code: 'STATE_UNAVAILABLE', message: sanitizeDetail(describe(error)) } })
      }
      return
    }
    if (req.method !== 'POST') {
      sendRouteJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and POST are supported' } })
      return
    }

    const body = await readJsonObject(req)
    if (body === undefined) {
      sendRouteJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: 'Body must be a JSON object' } })
      return
    }
    const validated = validateSelectionPatch(body)
    if ('error' in validated) {
      sendRouteJson(res, 400, { ok: false, error: { code: validated.error, message: 'Unknown selection value' } })
      return
    }
    if (Object.keys(validated.patch).length > 0) {
      try {
        await deps.setSelection(validated.patch)
      } catch (error) {
        sendRouteJson(res, 500, { ok: false, error: { code: 'SET_FAILED', message: sanitizeDetail(describe(error)) } })
        return
      }
    }
    try {
      sendRouteJson(res, 200, { ok: true, state: buildState(deps), error: null })
    } catch (error) {
      sendRouteJson(res, 500, { ok: false, error: { code: 'STATE_UNAVAILABLE', message: sanitizeDetail(describe(error)) } })
    }
  }

  const probeHandler = deps.probe === undefined
    ? undefined
    : async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isLoopbackRequest(req)) {
        sendRouteJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'This endpoint is loopback-only' } })
        return
      }
      if (req.method !== 'GET') {
        sendRouteJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } })
        return
      }
      try {
        const probe = deps.probe
        sendRouteJson(res, 200, { ok: true, probe: await probe!() })
      } catch (error) {
        sendRouteJson(res, 500, { ok: false, error: { code: 'PROBE_FAILED', message: sanitizeDetail(describe(error)) } })
      }
    }

  return {
    register(server: ZcodeWebServerLike): () => void {
      if (server === null || server === undefined || typeof server.register !== 'function') return () => {}
      const disposers: Array<() => void> = []
      const routes: ReadonlyArray<readonly [string, (req: IncomingMessage, res: ServerResponse) => Promise<void>]> = [
        [ZCODE_STATE_ROUTE_PATH, stateHandler],
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
