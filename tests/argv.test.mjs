// AC3 (argv contract): every shape carries `--mode guarded`, `--resume` appears
// only when there is an id to resume, and no configuration path can produce a
// mode that auto-approves tools. Pure function: no process is spawned here.

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildZcodeArgs } from '../lib/zcode/process.js'

const PROMPT = 'Summarise the file I just opened.'
const CWD = 'F:\\defws\\dsh-zcode-cli'

/** Position of `--mode` in an argv, or -1. */
function modeIndex(argv) {
  return argv.indexOf('--mode')
}

test('AC3: minimal input carries --mode guarded and the fixed shape', () => {
  const argv = buildZcodeArgs({ prompt: PROMPT, cwd: CWD })

  assert.deepEqual(argv, ['-p', PROMPT, '--mode', 'guarded', '--json', '--cwd', CWD])
  assert.notEqual(modeIndex(argv), -1)
  assert.equal(argv[modeIndex(argv) + 1], 'guarded')
})

test('AC3: input with a sessionId still carries --mode guarded', () => {
  const argv = buildZcodeArgs({ prompt: PROMPT, cwd: CWD, sessionId: 'sess_5f2c8a' })

  assert.notEqual(argv.indexOf('--mode'), -1)
  assert.equal(argv[argv.indexOf('--mode') + 1], 'guarded')
  // AC3: a session id alone must not opt into `--resume`; resume is explicit.
  assert.equal(argv.includes('--resume'), false)
  assert.equal(argv.includes('sess_5f2c8a'), false)
})

test('AC3: verbose input still carries --mode guarded, and --verbose is last', () => {
  const argv = buildZcodeArgs({ prompt: PROMPT, cwd: CWD, verbose: true })

  assert.notEqual(argv.indexOf('--mode'), -1)
  assert.equal(argv[argv.indexOf('--mode') + 1], 'guarded')
  assert.equal(argv[argv.length - 1], '--verbose')
  assert.deepEqual(argv.slice(-3), ['--cwd', CWD, '--verbose'])
})

test('AC3: no argv produced from any of the three shapes mentions a bypass mode', () => {
  const shapes = [
    { prompt: PROMPT, cwd: CWD },
    { prompt: PROMPT, cwd: CWD, sessionId: 'sess_5f2c8a' },
    { prompt: PROMPT, cwd: CWD, verbose: true },
  ]

  for (const shape of shapes) {
    const serialised = JSON.stringify(buildZcodeArgs(shape))
    assert.equal(serialised.includes('yolo'), false, `argv leaked a bypass mode: ${serialised}`)
  }
})

test('AC3: an explicit yolo mode is rejected with a TypeError', () => {
  // AC3: the guard is a type error, not a warning and not a silent fallback.
  assert.throws(
    () => buildZcodeArgs({ prompt: PROMPT, cwd: CWD, mode: 'yolo' }),
    TypeError,
  )
  assert.throws(
    () => buildZcodeArgs({ prompt: PROMPT, cwd: CWD, mode: 'Guarded' }),
    TypeError,
  )
})

test('AC3: an explicit guarded mode is accepted unchanged', () => {
  assert.deepEqual(
    buildZcodeArgs({ prompt: PROMPT, cwd: CWD, mode: 'guarded' }),
    ['-p', PROMPT, '--mode', 'guarded', '--json', '--cwd', CWD],
  )
})

test('AC3: --resume appears only when resume is requested with a usable id', () => {
  const resumed = buildZcodeArgs({ prompt: PROMPT, cwd: CWD, resume: true, sessionId: 'sess_5f2c8a' })
  assert.deepEqual(resumed.slice(-2), ['--resume', 'sess_5f2c8a'])
  assert.equal(resumed[resumed.indexOf('--mode') + 1], 'guarded')

  // Blank id: nothing to resume, so the flag is omitted rather than passed empty.
  const blank = buildZcodeArgs({ prompt: PROMPT, cwd: CWD, resume: true, sessionId: '   ' })
  assert.equal(blank.includes('--resume'), false)

  // resume:false with an id present: the id must not appear at all.
  const notResumed = buildZcodeArgs({ prompt: PROMPT, cwd: CWD, resume: false, sessionId: 'sess_5f2c8a' })
  assert.equal(notResumed.includes('--resume'), false)
  assert.equal(notResumed.includes('sess_5f2c8a'), false)
})

test('AC3: values that would be read as flags are rejected', () => {
  assert.throws(() => buildZcodeArgs({ prompt: PROMPT, cwd: CWD, resume: true, sessionId: '--evil' }), TypeError)
  assert.throws(() => buildZcodeArgs({ prompt: PROMPT, cwd: '--evil' }), TypeError)
  assert.throws(() => buildZcodeArgs({ prompt: '', cwd: CWD }), TypeError)
  assert.throws(() => buildZcodeArgs({ prompt: PROMPT, cwd: '' }), TypeError)
})
