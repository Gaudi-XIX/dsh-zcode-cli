/**
 * Session map, retention, per-conversation lock and durable store.
 *
 * AC8 lives here: one conversation must never have two ZCode sessions in flight,
 * different conversations must not wait for each other, and a lock that is
 * released twice must not corrupt the chain.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  InMemorySessionStore,
  SESSION_MAX_AGE_MS,
  SESSION_MAX_RECORDS,
  SessionRegistry,
} from '../lib/session/store.js'
import {
  FileSessionStore,
  ZCODE_PROVIDER_DIR,
  ZCODE_SESSION_FILE,
  ZCODE_SESSION_FILE_VERSION,
  createSessionRegistry,
  defaultSessionStorePath,
  resolveDshHome,
  sessionStorePath,
} from '../lib/session/file-store.js'

/** Fresh throwaway directory per test so no test can read another's file. */
function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'zcode-sessions-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('the in-memory store is a plain map keyed by conversation', () => {
  const store = new InMemorySessionStore()
  assert.equal(store.get('c1'), undefined)
  store.set({ sessionId: 'sess_a', conversationId: 'c1', updatedAt: 1 })
  assert.deepEqual(store.get('c1'), { sessionId: 'sess_a', conversationId: 'c1', updatedAt: 1 })
  assert.equal(store.size, 1)
  store.delete('c1')
  assert.equal(store.get('c1'), undefined)
  assert.equal(store.size, 0)
})

test('the registry remembers, forgets and reports the stored session', () => {
  let clock = 1_000
  const registry = new SessionRegistry(new InMemorySessionStore(), { now: () => clock })

  assert.equal(registry.get('c1'), undefined)
  const record = registry.set('c1', 'sess_1')
  assert.equal(record.conversationId, 'c1')
  assert.equal(record.sessionId, 'sess_1')
  assert.equal(registry.get('c1')?.sessionId, 'sess_1')

  clock += 10
  registry.set('c1', 'sess_2')
  assert.equal(registry.get('c1')?.sessionId, 'sess_2')

  registry.delete('c1')
  assert.equal(registry.get('c1'), undefined)
  registry.clear()
  assert.equal(registry.recordLimit, SESSION_MAX_RECORDS)
  assert.equal(registry.ageLimitMs, SESSION_MAX_AGE_MS)
})

test('AC8/retention: an expired record is not returned and is dropped on read', () => {
  let clock = 0
  const store = new InMemorySessionStore()
  const registry = new SessionRegistry(store, { now: () => clock, maxAgeMs: 100 })

  registry.set('c1', 'sess_old')
  clock = 101
  assert.equal(registry.get('c1'), undefined)
  assert.equal(store.size, 0, 'the expired entry is removed, not merely hidden')
})

test('retention keeps the newest `maxRecords` and reaps the rest', () => {
  let clock = 0
  const store = new InMemorySessionStore()
  const registry = new SessionRegistry(store, { now: () => clock, maxRecords: 2 })

  registry.set('old', 'sess_old')
  clock = 1
  registry.set('middle', 'sess_middle')
  clock = 2
  registry.set('newest', 'sess_newest')

  assert.equal(store.size, 2)
  assert.equal(registry.get('old'), undefined)
  assert.equal(registry.get('middle')?.sessionId, 'sess_middle')
  assert.equal(registry.get('newest')?.sessionId, 'sess_newest')
})

test('AC8: the same conversation serialises, and the lock is FIFO', async () => {
  const registry = new SessionRegistry(new InMemorySessionStore())
  const order = []

  const release1 = await registry.acquire('c1')
  order.push('first')

  const second = registry.acquire('c1').then(release => {
    order.push('second')
    return release
  })

  // Give the second acquire every chance to jump the queue.
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(order, ['first'], 'the second holder must wait')

  release1()
  const release2 = await second
  assert.deepEqual(order, ['first', 'second'])
  release2()
})

test('AC8: different conversations do not block each other', async () => {
  const registry = new SessionRegistry(new InMemorySessionStore())
  const releaseA = await registry.acquire('a')

  // Would hang forever (until the test timeout) if the lock were global.
  const releaseB = await registry.acquire('b')
  releaseB()
  releaseA()
})

test('releasing twice is harmless and leaves the chain usable', async () => {
  const registry = new SessionRegistry(new InMemorySessionStore())
  const release = await registry.acquire('c1')
  release()
  release()
  const again = await registry.acquire('c1')
  again()
})

test('a lock entry is dropped once nobody is queued behind it', async () => {
  const registry = new SessionRegistry(new InMemorySessionStore())
  const release = await registry.acquire('c1')
  assert.equal(registry.pendingLocks, 1)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.pendingLocks, 0)
})

test('the default store path is <DSH_HOME>/zcode-provider/sessions.json', () => {
  const home = join(tmpdir(), 'dsh-home-probe')
  assert.equal(resolveDshHome({ DSH_HOME: home }), home)
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), resolveDshHome({}), 'blank falls back to ~/.dsh')
  assert.equal(defaultSessionStorePath({ DSH_HOME: home }), join(home, ZCODE_PROVIDER_DIR, ZCODE_SESSION_FILE))
  // A configured relative path is resolved against the process cwd; an absolute
  // one is taken verbatim. Both must not throw.
  assert.equal(sessionStorePath('', { DSH_HOME: home }), defaultSessionStorePath({ DSH_HOME: home }))
  assert.equal(sessionStorePath(undefined, { DSH_HOME: home }), defaultSessionStorePath({ DSH_HOME: home }))
  assert.match(sessionStorePath('sub/sessions.json', { DSH_HOME: home }), /sub[\\/]sessions\.json$/)
})

test('the file store round-trips records through disk', t => {
  const path = join(tempDir(t), 'nested', 'sessions.json')
  const writer = new FileSessionStore(path, { now: () => 5_000 })
  writer.set({ sessionId: 'sess_a', conversationId: 'c1', updatedAt: 4_000 })

  const payload = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(payload.version, ZCODE_SESSION_FILE_VERSION)
  assert.equal(payload.records.length, 1)
  assert.equal(payload.records[0].sessionId, 'sess_a')

  // A second instance is the "restart": it must see the same record.
  const reader = new FileSessionStore(path, { now: () => 5_000 })
  assert.equal(reader.get('c1')?.sessionId, 'sess_a')
  assert.equal(reader.lastLoadError, undefined)
})

test('loading never throws, whatever the file contains', t => {
  const directory = tempDir(t)

  const corrupt = join(directory, 'corrupt.json')
  writeFileSync(corrupt, '{ not json', 'utf8')
  const fromCorrupt = new FileSessionStore(corrupt)
  assert.equal(fromCorrupt.get('c1'), undefined)
  assert.match(fromCorrupt.lastLoadError ?? '', /not valid JSON/)

  const wrongVersion = join(directory, 'version.json')
  writeFileSync(wrongVersion, JSON.stringify({ version: 99, records: [] }), 'utf8')
  const fromVersion = new FileSessionStore(wrongVersion)
  assert.equal(fromVersion.size, 0)
  assert.match(fromVersion.lastLoadError ?? '', /99/)

  const missing = new FileSessionStore(join(directory, 'absent.json'))
  assert.equal(missing.get('c1'), undefined)
  assert.equal(missing.lastLoadError, undefined, 'a missing file is the normal first run')
})

test('the loader accepts an array and a bare map, and rejects junk records', t => {
  const directory = tempDir(t)
  // `now` is pinned: the retention sweep runs during load, and a record stamped
  // `updatedAt: 1` would otherwise be "thirty days old" the moment it is read.
  const now = () => 1_000

  const arrayPath = join(directory, 'array.json')
  writeFileSync(arrayPath, JSON.stringify([{ sessionId: 'sess_a', conversationId: 'c1', updatedAt: 500 }]), 'utf8')
  assert.equal(new FileSessionStore(arrayPath, { now }).get('c1')?.sessionId, 'sess_a')

  // The key of the map form *is* the conversation id, so the record itself does
  // not have to repeat it.
  const mapPath = join(directory, 'map.json')
  writeFileSync(mapPath, JSON.stringify({ c2: { sessionId: 'sess_b', updatedAt: 500 } }), 'utf8')
  assert.equal(new FileSessionStore(mapPath, { now }).get('c2')?.sessionId, 'sess_b')

  const junkPath = join(directory, 'junk.json')
  writeFileSync(
    junkPath,
    JSON.stringify({ version: 1, records: [{ sessionId: '', conversationId: 'c3', updatedAt: 500 }, 42, null] }),
    'utf8',
  )
  const junk = new FileSessionStore(junkPath, { now })
  assert.equal(junk.size, 0, 'unusable records are skipped, not guessed at')
})

test('a failed write keeps the in-memory map and reports the reason', t => {
  // A path whose parent is an existing *file* cannot be created.
  const directory = tempDir(t)
  const blocker = join(directory, 'blocker')
  writeFileSync(blocker, 'not a directory', 'utf8')

  const store = new FileSessionStore(join(blocker, 'sessions.json'), { now: () => 1 })
  store.set({ sessionId: 'sess_a', conversationId: 'c1', updatedAt: 0 })
  assert.match(store.lastSaveError ?? '', /ENOTDIR|EEXIST|ENOENT|EPERM|EACCES/)
  assert.equal(store.get('c1')?.sessionId, 'sess_a', 'the turn that wrote must not lose the hint')
})

test('delete and clear persist the removal', t => {
  const path = join(tempDir(t), 'sessions.json')
  const store = new FileSessionStore(path, { now: () => 1 })
  store.set({ sessionId: 'sess_a', conversationId: 'c1', updatedAt: 0 })
  store.delete('c1')
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).records, [])

  store.set({ sessionId: 'sess_b', conversationId: 'c2', updatedAt: 0 })
  store.clear()
  assert.equal(store.size, 0)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).records, [])
})

test('createSessionRegistry wires a pruning registry over the configured path', t => {
  const path = join(tempDir(t), 'sessions.json')
  const { registry, store } = createSessionRegistry(path, { now: () => 1_000, maxAgeMs: 100 })
  assert.equal(store.path, path)
  registry.set('c1', 'sess_a')
  assert.equal(registry.get('c1')?.sessionId, 'sess_a')

  // The registry's own expiry applies to records that come back from disk.
  const reloaded = createSessionRegistry(path, { now: () => 1_001, maxAgeMs: 100 })
  assert.equal(reloaded.registry.get('c1')?.sessionId, 'sess_a')
})
