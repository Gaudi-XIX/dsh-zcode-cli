/**
 * Plugin-owned selection store: which channel, model and reasoning effort the
 * user picked in the settings card.
 *
 * Why a file of our own instead of the bundle config: the card has to change
 * the selection without a host restart, and the adapter has to read the same
 * value the card wrote. Writing ZCode's own `provider_config.json` is out of
 * the question — it belongs to another application and carries its API key.
 *
 * Layout: `<dsh home>/zcode-provider/selection.json`, atomic replace (write to
 * a temp name in the same directory, then `rename`), so a crash mid-write can
 * never leave a half-parsed selection behind.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Channels the adapter can route a turn through. */
export const ZCODE_CHANNEL_IDS = ['free', 'paid', 'cli'] as const
/** One channel id. */
export type ZcodeChannelId = typeof ZCODE_CHANNEL_IDS[number]

/** Reasoning efforts the upstream accepts in `output_config.effort`. */
export const ZCODE_EFFORT_IDS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** One effort id. */
export type ZcodeEffortId = typeof ZCODE_EFFORT_IDS[number]

/** Models the ZCode plan exposes (static: 0.17.0 has no quota-free listing). */
export const ZCODE_MODEL_IDS = ['GLM-5.3-Flash', 'GLM-5.3'] as const
/** One model id. */
export type ZcodeModelId = typeof ZCODE_MODEL_IDS[number]

/** The selection the card shows and the adapter uses. */
export interface ZcodeSelectionState {
  readonly channel: ZcodeChannelId
  readonly model: ZcodeModelId
  readonly effort: ZcodeEffortId
}

/** A partial write: only the keys present change. */
export interface ZcodeSelectionPatch {
  readonly channel?: string
  readonly model?: string
  readonly effort?: string
}

/** Used when the file is missing, unreadable or carries an unknown value. */
export const ZCODE_DEFAULT_SELECTION: ZcodeSelectionState = Object.freeze({
  // `cli` is the default because it is the only transport where the official
  // binary signs its own requests. The direct HTTP channels replay the CLI's
  // request shape, and ZCode's risk control answers `405 [3012] request has
  // been blocked due to unusual activity` once it decides the caller is not the
  // CLI — observed on this account after a handful of turns, with time-based
  // penalties. So HTTP stays selectable, but never the default.
  channel: 'cli',
  model: 'GLM-5.3-Flash',
  effort: 'max',
})

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/**
 * Validate one parsed record into a complete selection.
 *
 * Unknown or missing values fall back to the default per field: a card that
 * loses its selection because one field got corrupted is worse than a card that
 * resets that one field. `changed` reports whether anything had to be replaced,
 * so the caller can log the recovery instead of hiding it.
 */
export function parseSelectionState(
  value: unknown,
): { readonly selection: ZcodeSelectionState; readonly changed: boolean } {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const channel = includes(ZCODE_CHANNEL_IDS, record['channel']) ? record['channel'] : ZCODE_DEFAULT_SELECTION.channel
  const model = includes(ZCODE_MODEL_IDS, record['model']) ? record['model'] : ZCODE_DEFAULT_SELECTION.model
  const effort = includes(ZCODE_EFFORT_IDS, record['effort']) ? record['effort'] : ZCODE_DEFAULT_SELECTION.effort
  const changed = channel !== record['channel'] || model !== record['model'] || effort !== record['effort']
  return { selection: { channel, model, effort }, changed }
}

/**
 * Apply a partial patch onto a selection.
 *
 * @throws RangeError when a provided value is not a known id — a caller that
 * tries to write `channel: 'yolo'` must be told, not silently clamped.
 */
export function applySelectionPatch(
  current: ZcodeSelectionState,
  patch: ZcodeSelectionPatch,
): ZcodeSelectionState {
  const next = {
    channel: patch.channel === undefined ? current.channel : patch.channel,
    model: patch.model === undefined ? current.model : patch.model,
    effort: patch.effort === undefined ? current.effort : patch.effort,
  }
  if (!includes(ZCODE_CHANNEL_IDS, next.channel)) throw new RangeError(`unknown channel: ${String(next.channel)}`)
  if (!includes(ZCODE_MODEL_IDS, next.model)) throw new RangeError(`unknown model: ${String(next.model)}`)
  if (!includes(ZCODE_EFFORT_IDS, next.effort)) throw new RangeError(`unknown effort: ${String(next.effort)}`)
  return { channel: next.channel, model: next.model, effort: next.effort }
}

/** Resolve the selection file path without touching the disk. */
export function selectionFilePath(env: Record<string, string | undefined> = process.env): string {
  const home = env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  return join(home, 'zcode-provider', 'selection.json')
}

/** Injected seams; everything defaults to the real filesystem. */
export interface SelectionStoreOptions {
  readonly filePath?: string
  readonly env?: Record<string, string | undefined>
  readonly readText?: (path: string) => Promise<string>
  readonly writeText?: (path: string, text: string) => Promise<void>
  readonly makeDirectory?: (path: string) => Promise<void>
  readonly renameFile?: (from: string, to: string) => Promise<void>
  readonly removeFile?: (path: string) => Promise<void>
  readonly onRecovery?: (reason: string) => void
}

/**
 * File-backed selection with a synchronous in-memory view.
 *
 * `get()` is synchronous on purpose: the adapter calls it once per turn and
 * must not await a disk read there. `prime()` loads the file at boot, `write()`
 * persists and updates the cache in the same step.
 */
export class SelectionStore {
  readonly #filePath: string
  readonly #readText: (path: string) => Promise<string>
  readonly #writeText: (path: string, text: string) => Promise<void>
  readonly #makeDirectory: (path: string) => Promise<void>
  readonly #renameFile: (from: string, to: string) => Promise<void>
  readonly #removeFile: (path: string) => Promise<void>
  readonly #onRecovery: ((reason: string) => void) | undefined

  #current: ZcodeSelectionState = ZCODE_DEFAULT_SELECTION
  /** Serialises writes: two saves racing would otherwise interleave renames. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: SelectionStoreOptions = {}) {
    this.#filePath = options.filePath ?? selectionFilePath(options.env)
    this.#readText = options.readText ?? ((path) => readFile(path, 'utf8'))
    this.#writeText = options.writeText ?? ((path, text) => writeFile(path, text, 'utf8'))
    this.#makeDirectory = options.makeDirectory ?? (async (path) => { await mkdir(path, { recursive: true }) })
    this.#renameFile = options.renameFile ?? (async (from, to) => { await rename(from, to) })
    this.#removeFile = options.removeFile ?? (async (path) => { await unlink(path) })
    this.#onRecovery = options.onRecovery
  }

  /** Path this store persists to (exposed for diagnostics). */
  get filePath(): string {
    return this.#filePath
  }

  /** The current selection; never throws, never undefined. */
  get(): ZcodeSelectionState {
    return this.#current
  }

  /** Load the file into the cache. A missing file is normal, not an error. */
  async prime(): Promise<ZcodeSelectionState> {
    let text: string
    try {
      text = await this.#readText(this.#filePath)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined
      if (code === 'ENOENT') return this.#current
      this.#onRecovery?.(`selection file unreadable: ${String(code ?? error)}`)
      return this.#current
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.#onRecovery?.('selection file is not valid JSON')
      return this.#current
    }
    const { selection, changed } = parseSelectionState(parsed)
    if (changed) this.#onRecovery?.('selection file had missing or unknown values; recovered with defaults')
    this.#current = selection
    return selection
  }

  /** Persist a patch and return the new selection. */
  async write(patch: ZcodeSelectionPatch): Promise<ZcodeSelectionState> {
    const next = applySelectionPatch(this.#current, patch)
    const run = async (): Promise<ZcodeSelectionState> => {
      const directory = dirname(this.#filePath)
      await this.#makeDirectory(directory)
      const temp = `${this.#filePath}.${process.pid}.${Date.now().toString(36)}.tmp`
      try {
        await this.#writeText(temp, `${JSON.stringify(next, null, 2)}\n`)
        await this.#renameFile(temp, this.#filePath)
      } catch (error) {
        // Best effort: an orphan temp file must not survive a failed rename.
        try {
          await this.#removeFile(temp)
        } catch {
          // Nothing to clean up, or the cleanup itself failed; the write error wins.
        }
        throw error
      }
      this.#current = next
      return next
    }
    const queued = this.#queue.then(run, run)
    // Keep the chain alive after a rejection so one failed save does not block
    // every later save.
    this.#queue = queued.catch(() => undefined)
    return queued
  }
}
