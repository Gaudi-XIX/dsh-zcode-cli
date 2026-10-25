/**
 * Offline tests for `src/selection.ts` — the settings-card selection store.
 *
 * The store is exercised through injected fs seams, so nothing here touches the
 * real DSH home. The one behaviour worth its own file is the write queue: two
 * writes arriving together must compose against each other, which is what a
 * user flipping two dropdowns in quick succession relies on.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ZCODE_DEFAULT_SELECTION, SelectionStore, selectionFilePath } from '../lib/selection.js'

/** A store over memory seams: writes are recorded, nothing touches the disk. */
function memoryStore() {
  const writes = []
  const store = new SelectionStore({
    filePath: 'F:/fake/zcode-provider/selection.json',
    readText: async () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' })
    },
    writeText: async (path, text) => {
      writes.push(JSON.parse(text))
    },
    makeDirectory: async () => {},
    renameFile: async () => {},
    removeFile: async () => {},
  })
  return { store, writes }
}

test('two racing writes compose instead of losing the first field', async () => {
  const { store, writes } = memoryStore()

  // Both writes are issued before either resolves — the shape a quick pair of
  // dropdown changes produces. The patch must be applied inside the queue, so
  // the second write sees the first one's result.
  const [paid, effort] = await Promise.all([
    store.write({ plan: 'paid' }),
    store.write({ effort: 'low' }),
  ])

  assert.equal(paid.plan, 'paid')
  assert.equal(effort.plan, 'paid', 'the first write must survive the second')
  assert.equal(effort.effort, 'low')
  assert.deepEqual(writes.at(-1), { plan: 'paid', model: 'GLM-5.3-Flash', effort: 'low' })
  assert.deepEqual(store.get(), { plan: 'paid', model: 'GLM-5.3-Flash', effort: 'low' })
})

test('a rejected patch keeps the queue alive for the next write', async () => {
  const { store, writes } = memoryStore()

  await assert.rejects(() => store.write({ plan: 'yolo' }), RangeError)
  const next = await store.write({ effort: 'low' })
  assert.equal(next.effort, 'low')
  assert.deepEqual(next, { plan: 'free', model: 'GLM-5.3-Flash', effort: 'low' })
  assert.equal(writes.length, 1, 'the rejected patch never reached the disk')
})

test('an unknown field in the file recovers per-field and reports the change', async () => {
  const recoveries = []
  const store = new SelectionStore({
    filePath: 'F:/fake/zcode-provider/selection.json',
    readText: async () => JSON.stringify({ plan: 'gold', model: 'GLM-5.3-Flash' }),
    writeText: async () => {},
    makeDirectory: async () => {},
    renameFile: async () => {},
    removeFile: async () => {},
    onRecovery: (reason) => { recoveries.push(reason) },
  })
  const selection = await store.prime()
  assert.deepEqual(selection, ZCODE_DEFAULT_SELECTION)
  assert.ok(recoveries.length > 0)
})

test('the selection file path follows DSH_HOME with the conventional fallback', () => {
  assert.equal(
    selectionFilePath({ DSH_HOME: 'F:/fake/dsh' }).replaceAll('\\', '/'),
    'F:/fake/dsh/zcode-provider/selection.json',
  )
  assert.match(selectionFilePath({}), /zcode-provider[/\\]selection\.json$/)
})
