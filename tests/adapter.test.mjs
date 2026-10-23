/**
 * Adapter end-to-end, against a fake `zcode.cjs`.
 *
 * The real CLI is not exercised: its successful stdout was never captured, and
 * a live run spends a real quota unit. What *is* nailed down here is the
 * contract this adapter owns — the terminal frame order, the fail-closed tool
 * policy, the session binding, and the fact that `stream()` never throws.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { before, after } from 'node:test'

import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { ZcodeAdapter } from '../lib/provider/zcode.js'
import { clearQuotaObservation, lastQuotaObservation } from '../lib/diagnostics.js'
import { ZCODE_ENV_CONTRACT, missingEnvKeys } from '../lib/zcode/process.js'

/**
 * The fake CLI. Behaviour is selected by a marker inside the prompt, so one
 * fixture covers every branch without a second file per scenario.
 */
const FAKE_CLI = String.raw`
'use strict'
const { appendFileSync } = require('node:fs')

const argv = process.argv.slice(2)
const promptIndex = argv.indexOf('-p')
const prompt = promptIndex === -1 ? '' : (argv[promptIndex + 1] ?? '')
const resumeIndex = argv.indexOf('--resume')
const resume = resumeIndex === -1 ? null : (argv[resumeIndex + 1] ?? null)

const log = process.env.ZCODE_FAKE_LOG
if (log) appendFileSync(log, JSON.stringify({ prompt, resume, argv }) + '\n')

const print = value => process.stdout.write(JSON.stringify(value) + '\n')
const holdForever = () => setTimeout(() => {}, 60_000)

if (prompt.includes('@@json@@')) {
  print({ type: 'session', sessionId: 'sess_fake-0001' })
  print({ type: 'text_delta', text: '第一部分' })
  print({ type: 'text_delta', text: '第二部分' })
  print({ type: 'usage', usage: { input_tokens: 11, output_tokens: 7 } })
  print({ type: 'finish', stopReason: 'end_turn' })
} else if (prompt.includes('@@pretty@@')) {
  process.stdout.write(JSON.stringify({ type: 'text', text: 'single document answer' }, null, 2) + '\n')
} else if (prompt.includes('@@length@@')) {
  print({ type: 'text', text: 'cut off here' })
  print({ type: 'finish', stopReason: 'max_tokens' })
} else if (prompt.includes('@@toolstop@@')) {
  print({ type: 'text', text: 'I would call a tool' })
  print({ type: 'finish', stopReason: 'tool_use' })
} else if (prompt.includes('@@tool@@')) {
  print({ type: 'text', text: 'I would run Bash' })
  print({ type: 'tool_call', name: 'Bash' })
  holdForever()
} else if (prompt.includes('@@permission@@')) {
  print({ type: 'permission_request', toolName: 'Edit' })
  holdForever()
} else if (prompt.includes('@@quota@@')) {
  process.stderr.write(
    'ProviderBusinessError: [1309][您的GLM Coding Plan套餐已到期][2026102401123552bbdbe6a99a4f3d]\n'
    + "code: 'PROVIDER_BUSINESS_ERROR', providerCode: '1309', responseStatus: 429\n",
  )
  process.exitCode = 1
} else if (prompt.includes('@@error@@')) {
  print({ type: 'error', message: 'ProviderBusinessError: [1309][套餐已到期][req-frame]' })
} else if (prompt.includes('@@hang@@')) {
  // Prints nothing and never exits: only the supervisor's timers end this run.
  holdForever()
} else if (prompt.includes('@@silent@@')) {
  // Exit cleanly with nothing at all on stdout.
} else if (prompt.includes('@@exit3@@')) {
  process.stderr.write('worker thread died for no documented reason\n')
  process.exitCode = 3
} else {
  print({ type: 'text', text: 'default answer' })
}
`

let directory
let logPath
let savedEnv

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'zcode-adapter-'))
  logPath = join(directory, 'argv.jsonl')
  writeFileSync(logPath, '', 'utf8')
  writeFileSync(join(directory, 'fake-zcode.cjs'), FAKE_CLI, 'utf8')

  // `runZcode` reads the environment contract off `process.env`; the adapter has
  // no seam for it, so the test supplies a complete (dummy) contract.
  savedEnv = Object.fromEntries(ZCODE_ENV_CONTRACT.map(entry => [entry.name, process.env[entry.name]]))
  for (const entry of ZCODE_ENV_CONTRACT) process.env[entry.name] = process.env[entry.name] ?? 'test-value'
  process.env.ZCODE_FAKE_LOG = logPath
})

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  delete process.env.ZCODE_FAKE_LOG
  rmSync(directory, { recursive: true, force: true })
})

/** Adapter over the fake CLI, with a fresh session file per test. */
function adapter(t, overrides = {}) {
  const sessions = join(directory, `sessions-${Math.random().toString(36).slice(2)}.json`)
  const instance = new ZcodeAdapter({
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    nodePath: process.execPath,
    zcodeCjsPath: join(directory, 'fake-zcode.cjs'),
    sessionStorePath: sessions,
    timeoutMs: 20_000,
    idleTimeoutMs: 15_000,
    ...overrides,
  }, { logger: record => { t.diagnostic?.(JSON.stringify(record)) } })
  return instance
}

/** One user turn carrying the scenario marker. */
function request(text, extra = {}) {
  return {
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...extra,
  }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The terminal failure of a stream, or undefined when it ended cleanly. */
function terminalFailure(chunks) {
  const last = chunks.at(-1)
  assert.equal(last?.type, 'finish', 'every stream must end with a finish chunk')
  return last.reason.kind === 'error' ? last.reason.failure : undefined
}

function argvLog() {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line))
}

test('the provider surface advertises the configured route and policy', () => {
  const instance = new ZcodeAdapter({ model: 'GLM-5.3-Flash' }, { logger: () => {} })
  assert.deepEqual(instance.providerInfo('zcode'), { id: 'zcode', name: 'ZCode' })

  const policy = instance.providerRetryPolicy('zcode')
  assert.equal(policy.maxRetries, 2)
  assert.ok(policy.retryableCodes.includes('RATE_LIMIT'))
  assert.ok(policy.retryableCodes.includes('TIMEOUT'))
  // A quota failure never clears by retrying, and a bad identity needs a new
  // credential: neither may be retried.
  assert.ok(!policy.retryableCodes.includes('QUOTA'))
  assert.ok(!policy.retryableCodes.includes('AUTH'))
})

test('listModels honors visibleModels and advertises text-only input', async () => {
  const all = await adapter({}).listModels('zcode')
  assert.ok(all.length >= 2)
  assert.ok(all.every(model => model.provider === 'zcode'))
  assert.deepEqual(all[0].inputModalities, ['text'])

  const filtered = await adapter({}, { visibleModels: ['GLM-5.3'] }).listModels('zcode')
  assert.deepEqual(filtered.map(model => model.id), ['GLM-5.3'])
})

test('resolveModel refuses an unknown id and any id the CLI cannot run', async () => {
  const instance = adapter({}, { models: [{ id: 'GLM-5.3-Flash' }, { id: 'GLM-5.3', contextWindow: 200_000 }] })

  await assert.rejects(
    () => instance.resolveModel('zcode', 'not-a-model'),
    error => error.code === 'MODEL_NOT_FOUND' && /configured catalog/.test(error.message),
  )
  // Advertised but not the configured model: the CLI has no --model flag, so
  // running it would answer with a different model than the one requested.
  await assert.rejects(
    () => instance.resolveModel('zcode', 'GLM-5.3'),
    error => error.code === 'MODEL_NOT_FOUND' && /no --model flag/.test(error.message),
  )

  const resolved = await instance.resolveModel('zcode', 'GLM-5.3-Flash')
  assert.equal(resolved.id, 'GLM-5.3-Flash')
  assert.equal(resolved.provider, 'zcode')
  assert.deepEqual(resolved.inputModalities, ['text'])
})

test('a successful turn emits block-start, deltas, block-end, usage, finish', async t => {
  const before = argvLog().length
  const chunks = await collect(adapter(t).stream(request('@@json@@')))
  const types = chunks.map(chunk => chunk.type)

  assert.equal(types[0], 'block-start')
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(types[1], 'text-delta')
  assert.equal(types[2], 'text-delta')
  assert.equal(types[3], 'block-end')
  assert.deepEqual(chunks[3].block, { type: 'text', text: '第一部分第二部分' })
  assert.equal(types[4], 'usage')
  assert.deepEqual(chunks[4].usage, { inputTokens: 11, outputTokens: 7 })
  assert.equal(types[5], 'finish')
  assert.deepEqual(chunks[5].reason, { kind: 'stop' })

  const entry = argvLog().at(-1)
  assert.equal(argvLog().length, before + 1)
  assert.deepEqual(entry.argv.slice(0, 2), ['-p', entry.prompt])
  assert.ok(entry.argv.includes('--json'))
  assert.ok(entry.argv.includes('--mode') && entry.argv.includes('guarded'))
  assert.equal(entry.resume, null, 'the first turn has nothing to resume')
})

test('a pretty-printed single document still yields one text block', async t => {
  const chunks = await collect(adapter(t).stream(request('@@pretty@@')))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 1)
  assert.equal(chunks[2].block.text, 'single document answer')
  assert.equal(terminalFailure(chunks), undefined)
})

test('a max_tokens stop reason maps onto max-tokens', async t => {
  const chunks = await collect(adapter(t).stream(request('@@length@@')))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

test('a tool-call frame fails closed and kills the child', async t => {
  const chunks = await collect(adapter(t).stream(request('@@tool@@')))
  const failure = terminalFailure(chunks)
  assert.equal(failure?.code, 'UNSUPPORTED_TOOLS')
  assert.match(failure.message, /Bash/)
  // The turn is still reported as text the model produced before asking.
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks.at(-2).type, 'block-end')
})

test('a permission request fails closed with its own code', async t => {
  const chunks = await collect(adapter(t).stream(request('@@permission@@')))
  const failure = terminalFailure(chunks)
  assert.equal(failure?.code, 'PERMISSION_REQUIRED')
  assert.match(failure.message, /Edit/)
})

test('a quota exit keeps providerCode and request-id in the failure', async t => {
  // The quota recollector is process-wide, so the test owns its starting state:
  // this asserts the adapter *wrote* a record, not that one happened to exist.
  clearQuotaObservation()
  assert.equal(lastQuotaObservation(), null)

  const chunks = await collect(adapter(t).stream(request('@@quota@@')))
  const failure = terminalFailure(chunks)
  assert.equal(failure?.code, 'QUOTA')
  // The capture prints `responseStatus: 429`; since W4 fixed the status reader
  // that shape is read, so the failure carries the HTTP status too.
  assert.equal(failure.status, 429)
  assert.match(failure.message, /providerCode=1309/)
  assert.match(failure.message, /responseStatus=429/)
  assert.match(failure.message, /request-id=2026102401123552bbdbe6a99a4f3d/)

  // Same run, second surface: the adapter also hands the rejection to
  // `diagnostics`, which is what `doctor`'s `last-quota` check reports. The
  // observation is deliberately asserted here rather than in
  // `tests/doctor.test.mjs`, because only this file drives the real 1309
  // failure through `ZcodeAdapter.stream()`; the doctor test injects a record
  // and would pass even with this wiring missing.
  const observed = lastQuotaObservation()
  assert.equal(observed?.providerCode, '1309')
  assert.equal(observed?.requestId, '2026102401123552bbdbe6a99a4f3d')
  assert.match(observed?.observedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  // Recording must not add or reorder frames: still one terminal finish.
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

test('an in-band error frame and a stderr exit agree on the code', async t => {
  const inBand = terminalFailure(await collect(adapter(t).stream(request('@@error@@'))))
  assert.equal(inBand?.code, 'QUOTA')

  const stderr = terminalFailure(await collect(adapter(t).stream(request('@@exit3@@'))))
  assert.equal(stderr?.code, 'ZCODE_EXIT')
})

test('a clean exit with no output is never a silent success', async t => {
  const chunks = await collect(adapter(t).stream(request('@@silent@@')))
  const failure = terminalFailure(chunks)
  assert.equal(failure?.code, EMPTY_RESPONSE_CODE)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 0)
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 0)
})

test('a tool stop reason without a tool frame is unsupported tools', async t => {
  const failure = terminalFailure(await collect(adapter(t).stream(request('@@toolstop@@'))))
  assert.equal(failure?.code, 'UNSUPPORTED_TOOLS')
  assert.match(failure.message, /tool_use/)
})

test('AC5: the frame order holds on success, quota, timeout and cancellation', async t => {
  const order = chunks => {
    const types = chunks.map(chunk => chunk.type)
    assert.equal(types.at(-1), 'finish', 'finish must be the last chunk on every path')
    assert.equal(types.filter(type => type === 'finish').length, 1)
    // `usage`, when present, comes before the finish that reports the reason.
    const usageAt = types.lastIndexOf('usage')
    if (usageAt !== -1) assert.equal(usageAt, types.length - 2)
    // One text block, always closed before the terminal chunk.
    assert.equal(types.filter(type => type === 'block-start').length, types.filter(type => type === 'block-end').length)
    // This route owns no tool protocol: a tool frame must never be projected.
    assert.equal(types.filter(type => type === 'tool-call-delta' || type === 'tool-call').length, 0)
    assert.equal(
      chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type !== 'text').length,
      0,
      'only text blocks may be projected',
    )
    return types
  }

  order(await collect(adapter(t).stream(request('@@json@@ success'))))
  order(await collect(adapter(t).stream(request('@@quota@@'))))

  const timedOut = await collect(
    adapter(t, { timeoutMs: 20_000, idleTimeoutMs: 250 }).stream(request('@@hang@@')),
  )
  order(timedOut)
  assert.equal(terminalFailure(timedOut)?.code, 'TIMEOUT')

  const aborted = new AbortController()
  const pending = collect(adapter(t).stream(request('@@hang@@', { signal: aborted.signal })))
  setTimeout(() => aborted.abort(), 120)
  const cancelled = await pending
  order(cancelled)
  assert.equal(terminalFailure(cancelled)?.code, 'ABORTED')
})

test('AC8: the second turn resumes the remembered session and sends only new input', async t => {
  const instance = adapter(t, { sessionMode: 'resume' })
  const conversation = 'conversation-1'

  const first = await collect(instance.stream(request('@@json@@ first question', { sessionId: conversation })))
  assert.equal(terminalFailure(first), undefined)

  const history = [
    { role: 'user', content: [{ type: 'text', text: '@@json@@ first question' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: '第一部分第二部分' }],
      source: { kind: 'model', provider: 'zcode', model: 'GLM-5.3-Flash' },
    },
    { role: 'user', content: [{ type: 'text', text: '@@json@@ second question' }] },
  ]
  const second = await collect(instance.stream({ ...request(''), messages: history, sessionId: conversation }))
  assert.equal(terminalFailure(second), undefined)

  const turn = argvLog().at(-1)
  assert.equal(turn.resume, 'sess_fake-0001')
  assert.match(turn.prompt, /second question/)
  assert.doesNotMatch(turn.prompt, /first question/, 'the resumed session already holds the first turn')
})

test('pre-spawn refusals: dsh-owned tools, an oversized prompt, and a pre-aborted call', async t => {
  const before = argvLog().length
  const spawnCount = () => argvLog().length - before

  const dshOwned = adapter(t, { toolPolicy: 'dsh-owned' })
  const toolFailure = terminalFailure(await collect(dshOwned.stream(request('@@json@@', {
    tools: [{ name: 'Bash', description: 'run', parameters: {} }],
  }))))
  assert.equal(toolFailure?.code, 'UNSUPPORTED_TOOLS')
  assert.match(toolFailure.message, /dsh-owned/)

  const oversized = await collect(adapter(t).stream(request(`@@json@@ ${'x'.repeat(31_000)}`)))
  assert.equal(terminalFailure(oversized)?.code, 'ZCODE_UNKNOWN')
  assert.match(terminalFailure(oversized).message, /30000-character ceiling|character ceiling/)

  const aborted = new AbortController()
  aborted.abort()
  const cancelled = await collect(adapter(t).stream(request('@@json@@', { signal: aborted.signal })))
  assert.equal(terminalFailure(cancelled)?.code, 'ABORTED')

  assert.equal(spawnCount(), 0, 'all three refusals must happen before a process exists')
})

test('an auxiliary call neither takes the lock nor consumes the session id', async t => {
  const instance = adapter(t, { sessionMode: 'resume' })
  const conversation = 'conversation-aux'

  await collect(instance.stream(request('@@json@@ main turn', { sessionId: conversation })))
  // `purpose` marks a compaction/title call: it must not resume the user's
  // session, because the CLI would then see the auxiliary prompt as its next turn.
  const auxiliary = await collect(instance.stream(request('@@json@@ summarize', {
    sessionId: conversation,
    purpose: 'compaction',
  })))
  assert.equal(terminalFailure(auxiliary), undefined)

  const turn = argvLog().at(-1)
  assert.equal(turn.resume, null)
  assert.match(turn.prompt, /summarize/)
})

test('a missing environment contract fails closed before any spawn', async t => {
  const saved = {}
  for (const entry of ZCODE_ENV_CONTRACT) {
    saved[entry.name] = process.env[entry.name]
    delete process.env[entry.name]
  }
  try {
    assert.ok(missingEnvKeys(process.env).length > 0)
    const failure = terminalFailure(await collect(adapter(t).stream(request('@@json@@'))))
    assert.equal(failure?.code, 'ZCODE_ENV_MISSING')
    assert.match(failure.message, /ZCODE_HOME/)
  } finally {
    for (const [name, value] of Object.entries(saved)) process.env[name] = value
  }
})
