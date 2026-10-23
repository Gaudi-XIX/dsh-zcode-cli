/**
 * Bundle entry of the ZCode provider.
 *
 * This file is the whole registration surface — it owns the route name, the
 * settings namespace, and the adapter hand-off, and nothing else. Everything
 * that touches a process, a session or a stream lives behind it, so a host that
 * cannot load the adapter still gets a readable directory entry instead of a
 * half-mounted plugin.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

import { BundleConfig, configBoolean, type Config as ConfigType } from './provider/config.js'

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
export const ZCODE_DISPLAY_NAME = 'ZCode'

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
  })

  ctx.llm.registerAdapter([ZCODE_PROVIDER_ROUTE], adapter)
  logger.info('zcode: adapter registered on route %s', ZCODE_PROVIDER_ROUTE)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
