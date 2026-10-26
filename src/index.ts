/**
 * Bundle entry of the ZCode provider.
 *
 * This file is the whole registration surface — it owns the route name, the
 * settings namespace, and the adapter hand-off, and nothing else. Everything
 * that touches a process, a session or a stream lives behind it, so a host that
 * cannot load the adapter still gets a readable directory entry instead of a
 * half-mounted plugin.
 */

import { existsSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

import { BundleConfig, configBoolean, type Config as ConfigType } from './provider/config.js'
import { createZcodeWebRoutes, type ZcodeWebServerLike } from './web/router.js'
import { SelectionStore } from './selection.js'

/** Disposers for the routes this bundle mounted; drained on dispose. */
const webServerDisposers: Array<() => void> = []

/**
 * The live selection store, if `apply` has run.
 *
 * The adapter reads the same store the card writes, so switching plan, model
 * or effort takes effect on the next turn instead of needing a host restart.
 */
let selectionStoreRef: SelectionStore | undefined

/** The selection store mounted by this bundle, for the adapter and diagnostics. */
export function getSelectionStore(): SelectionStore | undefined {
  return selectionStoreRef
}

/** The host web server this bundle mounted onto, captured for the probe route. */
let mountedWebServer: ZcodeWebServerLike | undefined

function webServerRef(): ZcodeWebServerLike | undefined {
  return mountedWebServer
}

/**
 * The slice of the host context the diagnostic probe reads.
 *
 * Declared structurally instead of importing the full host types: the probe is
 * diagnostic only, and a wrong guess about an optional service must degrade to
 * a note in the report rather than a compile error in the provider path.
 */
interface ProbeContext {
  readonly llm?: {
    listProviders(): ReadonlyArray<{ id: string; name?: string }>
    listModels?(provider: string): Promise<ReadonlyArray<{ id: string; name?: string }>>
    resolveModelInfo?(provider: string, model: string): Promise<unknown>
  }
  get?(name: string): unknown
}

/** Describe an unknown thrown value without leaking secrets. */
function probeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Answer, from inside the host process, the two questions a browser cannot:
 * does the LLM registry really resolve this provider's models (the picker drops
 * a group whose resolution throws), and did the browser half reach the client
 * module graph (the settings card is served from there).
 */
async function catalogProbe(ctx: ProbeContext, webServer: ZcodeWebServerLike | undefined): Promise<unknown> {
  const report: Record<string, unknown> = {
    probeVersion: 'diag-1',
    webServerMounted: webServer !== undefined,
  }

  const llm = ctx.llm
  if (llm === undefined) {
    report['llm'] = 'absent'
  } else {
    let providers: unknown = null
    try {
      providers = llm.listProviders().map((provider) => ({ id: provider.id, name: provider.name }))
    } catch (error) {
      providers = probeError(error)
    }
    const perProvider: Record<string, unknown> = {}
    try {
      for (const provider of llm.listProviders()) {
        const row: Record<string, unknown> = {}
        try {
          const models = await llm.listModels!(provider.id)
          row['models'] = models.map((model) => ({ id: model.id, name: model.name }))
          const resolved: Record<string, unknown> = {}
          for (const model of models) {
            try {
              resolved[model.id] = await llm.resolveModelInfo!(provider.id, model.id)
            } catch (error) {
              resolved[model.id] = `THREW ${probeError(error)}`
            }
          }
          row['resolved'] = resolved
        } catch (error) {
          row['error'] = probeError(error)
        }
        perProvider[provider.id] = row
      }
    } catch (error) {
      perProvider['enumerate'] = probeError(error)
    }
    report['llm'] = { providers, perProvider }
  }

  const clientModules = ctx.get?.('clientModules')
  if (clientModules === undefined || clientModules === null) {
    report['clientModules'] = 'absent'
  } else {
    const shape: Record<string, unknown> = { ownKeys: Object.keys(clientModules as object) }
    const graph = (clientModules as { graph?: () => unknown }).graph
    if (typeof graph === 'function') {
      try {
        const value = graph.call(clientModules) as { entries?: unknown }
        shape['graph'] = value === null || value === undefined
          ? value
          : { entries: value.entries }
      } catch (error) {
        shape['graph'] = `THREW ${probeError(error)}`
      }
    }
    report['clientModules'] = shape
  }

  return report
}

/** Plugin identity; also the settings namespace the Models page keys on. */
export const name = 'dsh-zcode-provider'

/**
 * Services this plugin needs before `apply` runs.
 *
 * The adapter itself only needs `llm`, but the bundle is declared against the
 * full set so that a profile missing any of them refuses the mount instead of
 * failing at the first request.
 */
export const inject = ['llm', 'sessions', 'workspaceRegistry', 'sandboxPolicy', 'permissionPresets', 'approval']

/** Bundle default: enabled, with tools rejected. */
export const Config = BundleConfig

/** The DSH provider route owned by this plugin. */
export const ZCODE_PROVIDER_ROUTE = 'zcode'

/** Settings namespace; MUST equal the package name, which is what the UI matches. */
export const ZCODE_SETTINGS_NS = 'dsh-zcode-provider'

/** Display name of the provider card on the Models page. */
export const ZCODE_DISPLAY_NAME = 'ZCode CLI'

/**
 * Module specifier of the adapter implementation, resolved at apply time.
 *
 * It is held in a variable on purpose: the adapter lands in a later batch of
 * this build (B4), and a static import of a file that does not exist yet would
 * make every intermediate `tsc` run fail. Loading it lazily keeps this entry
 * point independently buildable and independently testable.
 */
const ADAPTER_MODULE_SPECIFIER = './provider/zcode.js'

/** Diagnostic sink handed to the adapter; one JSON line per record. */
export interface ZcodeAdapterDeps {
  readonly logger: (record: unknown) => void
  /** Resolve the session workspace root; see {@link createWorkspaceRootResolver}. */
  readonly resolveWorkspaceRoot?: ((conversationId: string | undefined) => Promise<string | undefined>) | undefined
  /**
   * Read the live selection this entry's store holds.
   *
   * Typed structurally here rather than imported from the adapter: this file is
   * the registration surface and loads the adapter dynamically, so a static
   * import of its types would make the two modules fail together.
   */
  readonly getSelection?: (() => { readonly plan?: string; readonly model?: string; readonly effort?: string } | undefined) | undefined
}

/** The slice of a DSH session record this entry reads. */
interface HostSessionLike {
  readonly header?: { readonly cwd?: unknown } | undefined
}

/** The slice of a DSH workspace record this entry reads. */
interface HostWorkspaceLike {
  readonly path?: unknown
  status?(): Promise<unknown>
}

/** The two host services the workspace resolver closes over. */
interface WorkspaceResolverServices {
  readonly sessions?: { get?(id: string): HostSessionLike | undefined } | undefined
  readonly workspaceRegistry?: { resolveByPath?(path: string): Promise<HostWorkspaceLike | undefined> } | undefined
}

/**
 * Build the `cwd` resolver the adapter calls before every spawn.
 *
 * The host knows the workspace, the adapter does not: `GenerateOptions` carries
 * no path, so the entry resolves session → `header.cwd` → `workspaceRegistry`
 * once per turn and hands the root down. Any missing link returns `undefined`,
 * which the adapter turns into `WORKSPACE_UNAVAILABLE`; it must never fall back
 * to `process.cwd()` (the DSH install directory, not the user's project).
 */
export function createWorkspaceRootResolver(
  ctx: Context,
): (conversationId: string | undefined) => Promise<string | undefined> {
  const services = ctx as unknown as WorkspaceResolverServices
  return async (conversationId) => {
    if (conversationId === undefined) return undefined
    const cwd = services.sessions?.get?.(conversationId)?.header?.cwd
    if (typeof cwd !== 'string' || cwd.trim().length === 0) return undefined
    const registry = services.workspaceRegistry
    if (registry?.resolveByPath === undefined) return undefined
    const workspace = await registry.resolveByPath(cwd)
    if (workspace === undefined) return undefined
    if (typeof workspace.status === 'function' && await workspace.status() !== 'ok') return undefined
    return typeof workspace.path === 'string' && workspace.path.trim().length > 0 ? workspace.path : cwd
  }
}

/**
 * Shape the adapter module must export.
 *
 * Frozen contract for B4: `src/provider/zcode.ts` exports a `ZcodeAdapter`
 * class whose constructor takes the resolved config and these deps, and which
 * implements `LlmAdapter`. The session registry and the durable session map are
 * constructed inside that module, not here — the two files that define them
 * belong to the same batch as the adapter.
 */
export interface ZcodeAdapterModule {
  readonly ZcodeAdapter: new (config: ConfigType, deps: ZcodeAdapterDeps) => LlmAdapter
}

/**
 * Mount the provider.
 *
 * The directory entry is registered unconditionally and before anything can
 * fail: it is what makes the plugin visible (and its config editable) on the
 * Models page, and losing it on a transient adapter failure would leave the
 * page showing a provider row with no card. The adapter is registered only when
 * the bundle is explicitly enabled.
 */
export async function apply(ctx: Context, config: ConfigType): Promise<void> {
  const logger = ctx.logger(ZCODE_SETTINGS_NS)

  // Settings panel: the local ZCode CLI appears as the `zcode` provider. The
  // namespace is the plugin name; settingsPath [] means the whole section is
  // the profile.
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: ZCODE_PROVIDER_ROUTE,
      displayName: ZCODE_DISPLAY_NAME,
      settingsNs: ZCODE_SETTINGS_NS,
      settingsPath: [],
    }])
  } catch (error) {
    // A duplicate directory entry means this profile mounts the plugin twice;
    // the first mount already owns the row, so the route stays usable.
    logger.warn('zcode: configurable provider registration refused: %s', describe(error))
  }

  // Settings card: the card reads its state (plan, model, effort) over a
  // loopback route and writes the selection back over the same route. The
  // selection lives in the plugin's own file store — never in ZCode's
  // `provider_config.json`, which belongs to another application and carries
  // its API key.
  //
  // Mounted before the `enabled` check on purpose: the card stays readable and
  // the selection stays switchable even when the adapter is off. A host without
  // a web server simply never runs the registration callback, and any failure
  // here costs the panel, never the provider row registered above.
  const selectionStore = new SelectionStore({
    onRecovery: (reason) => { logger.warn('zcode: selection recovered: %s', reason) },
  })
  selectionStoreRef = selectionStore
  try {
    await selectionStore.prime()
  } catch (error) {
    // `prime` already swallows the expected failures; this is belt and braces
    // so a surprise never takes the provider row down with it.
    logger.warn('zcode: selection not primed: %s', describe(error))
  }

  try {
    const routes = createZcodeWebRoutes({
      getConfig: () => selectionStore.get(),
      setSelection: async (patch) => { await selectionStore.write(patch) },
      probe: async () => catalogProbe(ctx as unknown as ProbeContext, webServerRef()),
    })
    ctx.inject(['webServer'], (innerCtx) => {
      const webServer = (innerCtx as unknown as { webServer?: ZcodeWebServerLike }).webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return
      mountedWebServer = webServer
      try {
        webServerDisposers.push(routes.register(webServer))
      } catch (error) {
        logger.warn('zcode: settings routes refused: %s', describe(error))
      }
    })
  } catch (error) {
    logger.warn('zcode: settings endpoint not mounted: %s', describe(error))
  }

  // No `registerModelDiscovery`: ZCode 0.17.0 has no quota-free model listing,
  // so the catalog is static and discovery would have to spend a real turn.

  // `enabled` is `.volatile()`, so the host hands `apply` a reference object
  // (`{ get() }`), not a primitive: `config.enabled !== true` was therefore
  // always true and the adapter was never registered. `configBoolean` accepts
  // both the primitive (programmatic config, tests) and the reference.
  if (!configBoolean(config.enabled)) {
    logger.info('zcode: disabled by config; adapter not registered')
    return
  }

  let module: ZcodeAdapterModule
  try {
    module = await import(ADAPTER_MODULE_SPECIFIER) as unknown as ZcodeAdapterModule
  } catch (error) {
    // Deliberately not thrown: this runs during host boot, and an unloadable
    // adapter must not take the whole profile down. The failure is logged with
    // the module specifier so it is actionable rather than silent.
    logger.error(
      'zcode: cannot load adapter module %s (%s); provider route not registered',
      ADAPTER_MODULE_SPECIFIER,
      describe(error),
    )
    return
  }

  if (typeof module.ZcodeAdapter !== 'function') {
    logger.error(
      'zcode: adapter module %s does not export a ZcodeAdapter class; provider route not registered',
      ADAPTER_MODULE_SPECIFIER,
    )
    return
  }

  const adapter = new module.ZcodeAdapter(config, {
    logger: (record) => {
      try {
        logger.info('%s', JSON.stringify(record))
      } catch (error) {
        logger.warn('zcode: diagnostic record was not serializable: %s', describe(error))
      }
    },
    resolveWorkspaceRoot: createWorkspaceRootResolver(ctx),
    // Re-read on every call: the card writes the store between turns, so a
    // one-shot read here would freeze whatever was selected at boot.
    // Still gated on the file existing: the store hands out its defaults for a
    // missing file, and those defaults name `free` — handing them over would
    // move a profile that deliberately runs `paid` onto an unverified plan the
    // moment it boots.
    getSelection: () => {
      try {
        return existsSync(selectionStore.filePath) ? selectionStore.get() : undefined
      } catch (error) {
        logger.warn('zcode: selection not readable: %s', describe(error))
        return undefined
      }
    },
  })

  ctx.llm.registerAdapter([ZCODE_PROVIDER_ROUTE], adapter)
  logger.info('zcode: adapter registered on route %s', ZCODE_PROVIDER_ROUTE)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
