/**
 * Durable session map.
 *
 * The map lives at `<DSH_HOME>/zcode-provider/sessions.json` and exists for one
 * reason: without it, a host restart forgets every `sess_…` id and
 * `sessionMode: 'resume'` silently degrades to `'full'` on every boot. It is a
 * convenience cache, never a source of truth, so every failure mode here is
 * non-fatal by design:
 *
 * - an unreadable or corrupt file loads as an empty map (`lastLoadError` keeps
 *   the reason for `doctor`);
 * - a failed write keeps the in-memory map intact (`lastSaveError`) instead of
 *   failing the turn that happened to trigger it — losing a session hint is
 *   cheaper than losing an answer.
 *
 * Writes are atomic (`tmp` + `rename`) because the host may be killed between
 * two writes: a torn JSON file would then be the *only* copy, and the loader
 * would have to guess what half a record means.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  SESSION_MAX_AGE_MS,
  SESSION_MAX_RECORDS,
  SessionRegistry,
  type EnumerableSessionStore,
  type SessionRecord,
  type SessionStore,
} from './store.js'

/** Directory under `DSH_HOME` that belongs to this plugin. */
export const ZCODE_PROVIDER_DIR = 'zcode-provider'
/** File name of the durable session map. */
export const ZCODE_SESSION_FILE = 'sessions.json'
/** On-disk format version; a mismatch discards the file rather than guessing. */
export const ZCODE_SESSION_FILE_VERSION = 1

/** Environment slice the path resolution reads. */
export type DshEnv = Readonly<Record<string, string | undefined>>

/**
 * Resolve `DSH_HOME`.
 *
 * `DSH_HOME` wins when set (the host may relocate its home), otherwise the
 * conventional `~/.dsh` is used. This mirrors the DSH home resolution the rest
 * of the harness performs; it is duplicated here rather than imported because
 * `dsh-home-paths` is a devDependency of this package and the runtime
 * dependency list is frozen at zero.
 */
export function resolveDshHome(env: DshEnv = process.env): string {
  const configured = env['DSH_HOME']
  const trimmed = configured?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? resolve(trimmed) : join(homedir(), '.dsh')
}

/** Default location of the durable session map. */
export function defaultSessionStorePath(env: DshEnv = process.env): string {
  return join(resolveDshHome(env), ZCODE_PROVIDER_DIR, ZCODE_SESSION_FILE)
}

/**
 * Resolve the configured path.
 *
 * @param configured - `config.sessionStorePath`; empty or blank means "default".
 * @param env - environment used for the default.
 */
export function sessionStorePath(configured: string | undefined, env: DshEnv = process.env): string {
  const trimmed = configured?.trim()
  if (trimmed === undefined || trimmed.length === 0) return defaultSessionStorePath(env)
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

/** Options of {@link FileSessionStore}. */
export interface FileSessionStoreOptions {
  /** Clock override for retention tests. */
  readonly now?: (() => number) | undefined
  /** Record ceiling; defaults to {@link SESSION_MAX_RECORDS}. */
  readonly maxRecords?: number | undefined
  /** Age ceiling; defaults to {@link SESSION_MAX_AGE_MS}. */
  readonly maxAgeMs?: number | undefined
}

interface SessionFilePayload {
  version: number
  records: SessionRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceRecord(value: unknown): SessionRecord | undefined {
  if (!isRecord(value)) return undefined
  const sessionId = value['sessionId']
  const conversationId = value['conversationId']
  const updatedAt = value['updatedAt']
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  return { sessionId, conversationId, updatedAt }
}

/**
 * Session map persisted as one JSON file.
 *
 * Reads are lazy and synchronous: the first access performs the (small) file
 * read, so constructing the store never touches the disk and a host that only
 * ever uses `sessionMode: 'full'` pays nothing for the feature.
 */
export class FileSessionStore implements EnumerableSessionStore {
  private readonly records = new Map<string, SessionRecord>()
  private readonly now: () => number
  private readonly maxRecords: number
  private readonly maxAgeMs: number
  private loaded = false
  private saveError: string | undefined
  private loadError: string | undefined

  constructor(
    readonly path: string,
    options: FileSessionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.maxRecords = options.maxRecords ?? SESSION_MAX_RECORDS
    this.maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS
  }

  /** Why the last load produced an empty map, when it did. */
  get lastLoadError(): string | undefined {
    return this.loadError
  }

  /** Why the last write failed, when it did. */
  get lastSaveError(): string | undefined {
    return this.saveError
  }

  get(conversationId: string): SessionRecord | undefined {
    this.ensureLoaded()
    return this.records.get(conversationId)
  }

  set(record: SessionRecord): void {
    this.ensureLoaded()
    this.records.set(record.conversationId, record)
    this.prune()
    this.flush()
  }

  delete(conversationId: string): void {
    this.ensureLoaded()
    if (this.records.delete(conversationId)) this.flush()
  }

  clear(): void {
    this.ensureLoaded()
    if (this.records.size === 0) return
    this.records.clear()
    this.flush()
  }

  entries(): Iterable<[string, SessionRecord]> {
    this.ensureLoaded()
    return this.records.entries()
  }

  /** Number of loaded records (forces the lazy load). */
  get size(): number {
    this.ensureLoaded()
    return this.records.size
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      const code = isRecord(error) ? error['code'] : undefined
      // A missing file is the normal first-run case, not an error worth keeping.
      if (code !== 'ENOENT') this.loadError = describe(error)
      return
    }
    try {
      this.absorb(JSON.parse(raw))
    } catch (error) {
      this.loadError = `sessions file is not valid JSON (${describe(error)}); starting empty`
      this.records.clear()
      return
    }
    this.prune()
  }

  /** Accept the documented payload, plus the two shapes a hand-edited file takes. */
  private absorb(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) this.absorbRecord(coerceRecord(entry))
      return
    }
    if (!isRecord(value)) {
      this.loadError = 'sessions file is not an object or array; starting empty'
      return
    }
    const version = value['version']
    if (typeof version === 'number' && version !== ZCODE_SESSION_FILE_VERSION) {
      this.loadError = `sessions file version ${version} is not ${ZCODE_SESSION_FILE_VERSION}; starting empty`
      return
    }
    const payload = value as Partial<SessionFilePayload>
    if (Array.isArray(payload.records)) {
      for (const entry of payload.records) this.absorbRecord(coerceRecord(entry))
      return
    }
    // A bare `{ conversationId: record }` map: the key *is* the conversation id,
    // so it is injected before coercion instead of after it (after it, a record
    // without its own `conversationId` would already have been rejected).
    for (const [conversationId, entry] of Object.entries(value)) {
      this.absorbRecord(coerceRecord(isRecord(entry) ? { ...entry, conversationId } : entry))
    }
  }

  private absorbRecord(record: SessionRecord | undefined): void {
    if (record === undefined) return
    if (this.now() - record.updatedAt > this.maxAgeMs) return
    this.records.set(record.conversationId, record)
  }

  private prune(): void {
    const kept = [...this.records.values()].sort((left, right) => right.updatedAt - left.updatedAt)
    for (const record of kept.slice(this.maxRecords)) this.records.delete(record.conversationId)
    for (const record of kept) {
      if (this.now() - record.updatedAt > this.maxAgeMs) this.records.delete(record.conversationId)
    }
  }

  private flush(): void {
    const payload: SessionFilePayload = {
      version: ZCODE_SESSION_FILE_VERSION,
      records: [...this.records.values()].sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
    }
    const temporary = `${this.path}.tmp-${process.pid}-${this.nextWriteId()}`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.path)
      this.saveError = undefined
    } catch (error) {
      this.saveError = describe(error)
      // Best effort: a leftover temp file must not turn into a leak per turn.
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Nothing further to do; the next write uses a fresh name.
      }
    }
  }

  private nextWriteId(): number {
    this.writeId += 1
    return this.writeId
  }

  private writeId = 0
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Build the registry the adapter uses.
 *
 * @param configuredPath - `config.sessionStorePath`.
 * @param options - clock and retention overrides (tests).
 * @param env - environment used when the configured path is empty.
 */
export function createSessionRegistry(
  configuredPath: string | undefined,
  options: FileSessionStoreOptions = {},
  env: DshEnv = process.env,
): { registry: SessionRegistry; store: SessionStore; path: string } {
  const path = sessionStorePath(configuredPath, env)
  const store = new FileSessionStore(path, options)
  return { registry: new SessionRegistry(store, options), store, path }
}
