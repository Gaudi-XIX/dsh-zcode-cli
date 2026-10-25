/**
 * Offline tests for `src/zcode/app-server.ts` — a scripted fake spawn drives
 * the session lifecycle end to end: readiness probe, account injection,
 * create/resume, streaming frames, callbacks, terminal mapping, cleanup.
 *
 * The FakeChild implements enough of ChildProcess (stdout/stderr as byte-
 * pushing EventEmitters with setEncoding) for AppServerSession to run
 * unmodified.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import {
  probeZcodeAppServerSettings,
  runZcodeAppServerTurn,
} from '../lib/zcode/app-server.js'

const NODE = 'D:/nodejs/node.exe'
const ZCODE_CJS = 'F:/AgentData/zcode/cli/resources/glm/zcode.cjs'
const ACCOUNT = { updateParams: { revision: 'account:test', basedOnZCodeBuiltinRevision: 'zcode-builtin:33:ab', providers: {}, states: {} } }

/** A fake stdout/stderr stream: setEncoding + data events. */
class FakeStream extends EventEmitter {
  setEncoding() {}
  push(text) { this.emit('data', Buffer.from(text, 'utf8')) }
}

/** One fake child process: scripted stdout traffic, recorded stdin writes. */
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdinWrites = []
    this.killed = false
    this.stdout = new FakeStream()
    this.stderr = new FakeStream()
    this.stdin = {
      write: (chunk) => {
        const text = String(chunk)
        this.stdinWrites.push(text)
        let rest = text
        let idx
        while ((idx = rest.indexOf('\n')) >= 0) {
          this.requests.push(JSON.parse(rest.slice(0, idx)))
          rest = rest.slice(idx + 1)
        }
      },
      end: () => {},
    }
    this.requests = []
    this.unhandled = []
  }
  /** Scripted output: queue a wire line to stdout and let handlers run. */
  out(obj) { this.stdout.push(JSON.stringify(obj) + '\n') }
}

/**
 * Script harness: registers per-method responders; request(id,result) is
 * answered automatically for anything without a responder.
 */
function scriptChild(child, responders, seen = null) {
  child.scriptDrain = () => {
    for (const req of child.requests.splice(0)) {
      if (seen !== null && req.method !== undefined) seen.push(req)
      const responder = responders[req.method]
      if (responder !== undefined) responder(req)
      else if (req.method !== undefined) child.out({ id: req.id, result: {} })
      else child.unhandled.push(req)
    }
  }
  return child
}

function makeDeps(childRef, respond, opts = {}) {
  return {
    nodePath: NODE,
    zcodeCjsPath: ZCODE_CJS,
    env: { ZCODE_HOME: 'F:/fake/home' },
    workspacePath: 'F:/fake/ws',
    workspaceKey: 'ws-key',
    planToken: () => 'jwt-fake-token',
    spawn: (cmd, args, spawnOpts) => {
      const child = new FakeChild()
      childRef.child = child
      childRef.spawnCmd = cmd
      childRef.spawnArgs = args
      childRef.spawnOpts = spawnOpts
      childRef.seen = []
      scriptChild(child, respond(child), childRef.seen)
      // Drain after each stdin write (a request may trigger more output).
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = (chunk) => { write(chunk); queueMicrotask(() => child.scriptDrain()) }
      return child
    },
    terminateProcessTree: (target) => { target.killed = true; return Promise.resolve() },
    // Microtask sleep keeps the 60-probe readiness loop off the real timer
    // wheel: interacting real timers with the runner's bookkeeping OOMs.
    delay: async () => {},
    ...(opts.overrides ?? {}),
  }
}
/** Drain keeps a full copy of every request seen, surviving splice. */

const result = (id, res) => ({ id, result: res })
/**
 * Wire-shape helper: the real CLI emits a JSON-RPC notification whose params
 * ARE the event document (`{type, payload, seq, sessionId}`), not wrapped in a
 * `params.event` key (locked against the live wire in `probe-cont3.cjs`).
 */
const event = (sessionId, type, payload) => ({ method: 'session/event', params: { sessionId, type, seq: 1, payload } })
/** The standard ready/inject/create responders used by most tests. */
function baseRespond(child, settings = { thoughtLevel: { available: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] }, model: { available: [{ ref: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash' } }] } }, sessionId = 'sess-1') {
  return {
    'provider/refreshRegistry': (req) => child.out(result(req.id, { refreshed: true })),
    'provider/updateAccountConfig': (req) => child.out(result(req.id, { receivedRevision: 'account:test', providerCount: 10, status: 'ok' })),
    'session/create': (req) => child.out(result(req.id, { session: { sessionId, settings } })),
    'session/resume': (req) => child.out(result(req.id, { session: { sessionId: req.params.sessionId, settings } })),
    'session/subscribe': (req) => child.out(result(req.id, {})),
    'session/send': (req) => child.out(result(req.id, { turnId: 'turn-1' })),
    'session/close': (req) => child.out(result(req.id, {})),
  }
}

test('runZcodeAppServerTurn: happy path — probe, inject, create, subscribe, send, stream, terminal', async () => {
  const childRef = {}
  let created = false
  const deps = makeDeps(childRef, (child) => ({
    ...baseRespond(child, undefined, 'sess-1'),
    'session/create': (req) => { created = true; child.out(result(req.id, { session: { sessionId: 'sess-1', settings: { thoughtLevel: { available: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] }, model: { available: [{ ref: 'ref-1' }] } } } })) },
    'session/send': (req) => {
      child.out(result(req.id, { turnId: 'turn-1' }))
      child.out(event('sess-1', 'model.streaming', { kind: 'text_start', assistantMessageId: 'm1' }))
      child.out(event('sess-1', 'model.streaming', { kind: 'text_delta', delta: 'pon', assistantMessageId: 'm1' }))
      child.out(event('sess-1', 'model.streaming', { kind: 'text_delta', delta: 'g', assistantMessageId: 'm1' }))
      child.out(event('sess-1', 'model.streaming', { kind: 'text_end', assistantMessageId: 'm1' }))
      child.out(event('sess-1', 'turn.terminal', { status: 'success', resultType: 'completed', durationMs: 1200, tokenCount: 10, toolCallCount: 0 }))
    },
  }))
  const res = await runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'low', prompt: 'Reply with exactly: pong' })
  assert.equal(res.terminal, 'success')
  assert.deepEqual(res.frames.map(f => ({ kind: f.kind, text: f.text })), [{ kind: 'text', text: 'pon' }, { kind: 'text', text: 'g' }])
  assert.equal(res.zcodeSessionId, 'sess-1')
  const sent = childRef.seen.find(r => r.method === 'session/send')
  assert.deepEqual(sent.params.modelSelection, { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } })
  assert.ok(created)
  assert.equal(childRef.seen.some(r => r.method === 'session/resume'), false)
  assert.ok(childRef.child.killed, 'child was torn down')
})

test('runZcodeAppServerTurn: resume uses session/resume and the given sessionId', async () => {
  const childRef = {}
  let resumed = null
  const deps = makeDeps(childRef, (child) => ({
    ...baseRespond(child, { thoughtLevel: { available: [{ value: 'low' }] }, model: { available: [] } }, 'sess-9'),
    'session/resume': (req) => { resumed = req.params; child.out(result(req.id, { session: { sessionId: 'sess-9', settings: { thoughtLevel: { available: [{ value: 'low' }] }, model: { available: [] } } } })) },
    'session/send': (req) => {
      child.out(result(req.id, { turnId: 't' }))
      child.out(event('sess-9', 'turn.terminal', { status: 'success' }))
    },
  }))
  const res = await runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'p', modelId: 'm', reasoningLevel: 'low', prompt: 'hi', resumeSessionId: 'sess-9' })
  assert.equal(res.zcodeSessionId, 'sess-9')
  assert.equal(resumed.sessionId, 'sess-9')
})

test('callbacks: requestProviderRuntimeHeaders returns the JWT + fixed headers; runtime preferences answered', async () => {
  const childRef = {}
  const deps = makeDeps(childRef, (child) => ({
    ...baseRespond(child),
    'session/send': (req) => {
      child.out(result(req.id, { turnId: 't' }))
      child.out({ id: 'cb-1', method: 'interaction/requestProviderRuntimeHeaders', params: {} })
      child.out({ id: 'cb-2', method: 'session/requestRuntimePreferences', params: {} })
      child.out(event('sess-1', 'turn.terminal', { status: 'success' }))
    },
  }))
  await runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'p', modelId: 'm', reasoningLevel: 'low', prompt: 'x' })
  // The host answers CLI→host callbacks by writing to stdin; recover both replies
  // from the recorded stdin writes (requests were spliced away by the drain).
  const replies = childRef.child.stdinWrites.flatMap((w) => w.trim().split('\n')).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const headersReply = replies.find((r) => r.id === 'cb-1')
  const prefsReply = replies.find((r) => r.id === 'cb-2')
  assert.ok(headersReply, 'headers reply sent')
  assert.equal(headersReply.result.headersApplied, true)
  assert.equal(headersReply.result.requestAuth.apiKey, 'jwt-fake-token')
  assert.deepEqual(headersReply.result.requestAuth.headers, { 'http-referer': 'https://zcode.z.ai', 'x-title': 'Z Code@cli' })
  assert.ok(prefsReply)
  assert.equal(prefsReply.result.nativeSearchEnhancementsEnabled, false)
  assert.equal(prefsReply.result.memoryEnabled, false)
  assert.equal(prefsReply.result.askUserQuestionAutoResolutionEnabled, true)
  assert.equal(prefsReply.result.modelContextBudgetStrategy, 'preflight-v1')
})

test('both live terminal envelopes resolve to success', async () => {
  // Envelope (a): v4/telemetry/event — kind/status at params top level.
  {
    const childRef = {}
    const deps = makeDeps(childRef, (child) => ({
      ...baseRespond(child),
      'session/send': (req) => {
        child.out(result(req.id, { turnId: 't' }))
        child.out({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: 'success', resultType: 'success', durationMs: 6504, tokenCount: 28555, toolCallCount: 0 } })
      },
    }))
    const res = await runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'p', modelId: 'm', reasoningLevel: 'low', prompt: 'x' })
    assert.equal(res.terminal, 'success')
  }
  // Envelope (b): session/event + type:'turn.completed', success in payload.resultType.
  {
    const childRef = {}
    const deps = makeDeps(childRef, (child) => ({
      ...baseRespond(child),
      'session/send': (req) => {
        child.out(result(req.id, { turnId: 't' }))
        child.out(event('sess-1', 'turn.completed', { response: 'ok', resultType: 'success', tokenCount: 10, usage: { source: 'provider', modelRequestCount: 1, inputTokens: 8, outputTokens: 2, totalTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }))
      },
    }))
    const res = await runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'p', modelId: 'm', reasoningLevel: 'low', prompt: 'x' })
    assert.equal(res.terminal, 'success')
    const usage = res.frames.find((f) => f.kind === 'usage')
    assert.ok(usage, 'usage frame present')
  }
})

test('thinking deltas become kind=thinking frames; terminal failure carries error fields', async () => {
  const childRef = {}
  const deps = makeDeps(childRef, (child) => ({
    ...baseRespond(child),
    'session/send': (req) => {
      child.out(result(req.id, { turnId: 't' }))
      child.out(event('sess-1', 'model.streaming', { kind: 'reasoning_delta', delta: 'hmm' }))
      child.out(event('sess-1', 'model.streaming', { kind: 'text_delta', delta: 'hi' }))
      child.out(event('sess-1', 'turn.terminal', { status: 'failed', errorCode: 'RATE_LIMITED', errorMessage: 'too many requests' }))
    },
  }))
  const res = await runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'p', modelId: 'm', reasoningLevel: 'low', prompt: 'x' })
  assert.deepEqual(res.frames, [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'hi' }])
  assert.equal(res.terminal, 'failed')
  assert.equal(res.errorCode, 'RATE_LIMITED')
  assert.equal(res.errorMessage, 'too many requests')
})

test('readiness: refreshRegistry that never refreshes → TIMEOUT after the retry budget', async () => {
  const childRef = {}
  let calls = 0
  const deps = makeDeps(childRef, (child) => ({
    'provider/refreshRegistry': (req) => { calls += 1; child.out(result(req.id, { refreshed: false })) },
  }), {
    overrides: {
      timeoutMs: 1500,
      idleTimeoutMs: 500,
    },
  })
  await assert.rejects(
    () => runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'p', modelId: 'm', reasoningLevel: 'low', prompt: 'x' }),
    (err) => err.code === 'TIMEOUT' || err.code === 'ZCODE_UNKNOWN',
  )
  assert.ok(calls >= 1)
  assert.ok(childRef.child.killed, 'stuck child is killed')
})

test('probeZcodeAppServerSettings returns thoughtLevels and availability', async () => {
  const childRef = {}
  const deps = makeDeps(childRef, (child) => baseRespond(child))
  const res = await probeZcodeAppServerSettings(deps, ACCOUNT)
  assert.deepEqual([...res.thoughtLevels], ['low', 'high', 'max'])
  assert.deepEqual([...res.available], [{ providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash' }])
})
test('spawn is node + zcode.cjs app-server --stdio with the required env', async () => {
  const childRef = {}
  const deps = makeDeps(childRef, (child) => baseRespond(child))
  await probeZcodeAppServerSettings(deps, ACCOUNT)
  assert.equal(childRef.spawnCmd, NODE)
  assert.deepEqual(childRef.spawnArgs, [ZCODE_CJS, 'app-server', '--stdio'])
  assert.equal(childRef.spawnOpts.env.ZCODE_HOME, 'F:/fake/home')
})

test('terminal envelope where the kind sits in payload.kind resolves (session/event shape)', { timeout: 5_000 }, async () => {
  // The kind word may arrive at `payload.kind` rather than `params.type`; a
  // recognizer that only checks the top-level carriers would never see the
  // terminal event and the turn would hang until the idle watchdog. The real
  // timeout knob is covered elsewhere; the test timeout here is the guard
  // against regressing into that hang.
  const childRef = {}
  const deps = makeDeps(childRef, (child) => ({
    ...baseRespond(child),
    'session/send': (req) => {
      child.out(result(req.id, { turnId: 't' }))
      child.out({ method: 'session/event', params: { sessionId: 'sess-1', seq: 1, payload: { kind: 'turn.completed', response: 'ok', resultType: 'success' } } })
    },
  }))
  const res = await runZcodeAppServerTurn(deps, ACCOUNT, { providerId: 'p', modelId: 'm', reasoningLevel: 'low', prompt: 'x' })
  assert.equal(res.terminal, 'success')
  assert.equal(res.responseText, 'ok')
})
