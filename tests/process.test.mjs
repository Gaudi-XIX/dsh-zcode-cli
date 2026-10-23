// Process-layer guards that cannot be reached through the adapter: the
// taskkill escalation runs only when a turn is already being torn down, and its
// failure mode (an async spawn error) is exactly what would crash the host.
//
// `terminateProcessTree` takes the spawn function as an argument for this file:
// a real `taskkill` spawn rarely fails, so the failure path is driven with a
// fake runner instead of being left unguarded.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { terminateProcessTree } from '../lib/zcode/process.js'

/** A child stub that records the signals it receives. */
function fakeChild(pid = 4242) {
  const signals = []
  return {
    pid,
    signals,
    kill(signal) {
      signals.push(signal)
      return true
    },
  }
}

test('a failed taskkill is reported as a diagnostic instead of crashing the host', { skip: process.platform !== 'win32' }, () => {
  const child = fakeChild()
  const diagnostics = []
  const killer = new EventEmitter()
  const seen = []
  const runner = (command, args, options) => {
    seen.push({ command, args, options })
    return killer
  }

  terminateProcessTree(child, (record) => diagnostics.push(record), runner)

  // The command is a fixed shape: a tree kill of this pid, never a shell string.
  assert.equal(seen.length, 1)
  assert.equal(seen[0].command, 'taskkill')
  assert.deepEqual(seen[0].args, ['/pid', '4242', '/t', '/f'])
  assert.equal(seen[0].options.shell, false)

  // Without a listener this event is an uncaught exception in the host process.
  assert.equal(killer.listenerCount('error'), 1)
  killer.emit('error', new Error('spawn taskkill EACCES'))

  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].kind, 'zcode.process.taskkill.failed')
  assert.equal(diagnostics[0].pid, 4242)
  assert.match(diagnostics[0].message, /EACCES/)

  // The escalation still happens: a failed taskkill falls back to SIGKILL.
  assert.deepEqual(child.signals, ['SIGKILL'])
})

test('a child without a pid is left alone', { skip: process.platform !== 'win32' }, () => {
  const diagnostics = []
  let spawned = 0
  const runner = () => {
    spawned += 1
    return new EventEmitter()
  }
  terminateProcessTree({ pid: undefined, kill() {} }, (record) => diagnostics.push(record), runner)
  assert.equal(spawned, 0)
  assert.equal(diagnostics.length, 0)
})
