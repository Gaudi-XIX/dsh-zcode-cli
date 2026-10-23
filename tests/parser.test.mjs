/**
 * Stdout recognizer.
 *
 * The shape of a *successful* ZCode stdout was never observed (the only run that
 * got that far failed with providerCode 1309), so these tests fix the contract
 * rather than a sample: text is found in both plausible layouts, an
 * unrecognizable capture is an error, and nothing is ever invented as text.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PARSE_PREVIEW_MAX_CHARS,
  ZCODE_SESSION_ID_PREFIX,
  ZcodeStreamParser,
  classifyJsonValue,
  frameSessionId,
  frameText,
  frameUsage,
  parseStdout,
} from '../lib/zcode/parser.js'
import { isZcodeError } from '../lib/provider/error-codes.js'

/** One NDJSON chunk: a session frame, two deltas, usage, and a finish frame. */
const NDJSON = [
  '{"type":"session","sessionId":"sess_477143eb-6589-4e57-936c-800e3fd975e6"}',
  '{"type":"text_delta","text":"你好，"}',
  '{"type":"text_delta","text":"世界"}',
  '{"type":"usage","usage":{"input_tokens":12,"output_tokens":5,"cached_tokens":3}}',
  '{"type":"finish","stopReason":"end_turn"}',
  '',
].join('\n')

test('NDJSON frames are recognized in arrival order', () => {
  const result = parseStdout(NDJSON)
  assert.equal(result.mode, 'ndjson')
  assert.deepEqual(result.deltas, ['你好，', '世界'])
  assert.equal(result.text, '你好，世界')
  assert.equal(result.sessionId, 'sess_477143eb-6589-4e57-936c-800e3fd975e6')
  assert.equal(result.stopReason, 'end_turn')
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3 })
  assert.equal(result.failure, undefined)
  assert.equal(result.unknownLines, 0)
  assert.deepEqual(result.toolRequests, [])
})

test('a pretty-printed single document is recovered by the whole-segment pass', () => {
  const stdout = JSON.stringify({ type: 'text', text: 'one document' }, null, 2)
  const result = parseStdout(stdout)
  // No individual line is valid JSON, so the line pass found nothing usable and
  // the whole capture had to be re-parsed as one value.
  assert.equal(result.mode, 'whole-json')
  assert.equal(result.text, 'one document')
})

test('a single JSON line and a bare JSON string are both text', () => {
  assert.equal(parseStdout('{"type":"text","text":"hello"}').text, 'hello')
  assert.equal(parseStdout('"just a string"').text, 'just a string')
})

test('content blocks contribute only their text', () => {
  const blocks = JSON.stringify({
    type: 'assistant',
    content: [
      { type: 'text', text: 'answer' },
      { type: 'thinking', text: 'hidden reasoning' },
      { type: 'tool_use', name: 'read' },
    ],
  })
  assert.equal(parseStdout(blocks).text, 'answer')
})

test('an empty capture fails closed with ZCODE_PARSE instead of an empty answer', () => {
  assert.throws(
    () => parseStdout(''),
    (error) => {
      assert.ok(isZcodeError(error))
      assert.equal(error.code, 'ZCODE_PARSE')
      assert.match(error.message, /no output at all/)
      return true
    },
  )
})

test('a capture with neither text nor error fails closed and keeps a preview', () => {
  const stdout = `${'x'.repeat(PARSE_PREVIEW_MAX_CHARS + 40)}\n`
  assert.throws(
    () => parseStdout(stdout),
    (error) => {
      assert.equal(error.code, 'ZCODE_PARSE')
      assert.match(error.message, /no recognizable text frame/)
      assert.ok(error.stderrTail !== undefined && error.stderrTail.length <= PARSE_PREVIEW_MAX_CHARS)
      return true
    },
  )
})

test('an in-band error frame is classified, not swallowed', () => {
  const stdout = '{"type":"error","message":"ProviderBusinessError: [1309][套餐已到期][req-1]"}'
  const result = parseStdout(stdout)
  assert.equal(result.text, '')
  assert.equal(result.failure?.code, 'QUOTA')
  assert.equal(result.failure?.providerCode, 1309)
})

test('tool and permission frames are surfaced for the fail-closed path', () => {
  const tool = parseStdout('{"type":"tool_call","name":"Bash"}\n{"type":"text","text":"after"}')
  assert.equal(tool.toolRequests.length, 1)
  assert.deepEqual(tool.toolRequests[0], { kind: 'tool', request: 'tool-call', toolName: 'Bash' })
  assert.equal(tool.text, 'after', 'the text of the same capture is still collected')

  // A capture that holds *only* a permission frame has no answer in it, so the
  // whole-segment parser fails closed; the frame is still readable through the
  // stream parser, which is what the adapter runs on live output.
  assert.throws(() => parseStdout('{"type":"permission_request","toolName":"Edit"}'), {
    code: 'ZCODE_PARSE',
  })
  const parser = new ZcodeStreamParser()
  const frames = parser.pushChunk('{"type":"permission_request","toolName":"Edit"}\n{"type":"text","text":"after"}\n')
  assert.deepEqual(frames, [
    { kind: 'tool', request: 'permission', toolName: 'Edit' },
    { kind: 'text', text: 'after' },
  ])
})

test('a finish frame may carry the final text, and a tool stop reason is preserved', () => {
  const result = parseStdout('{"type":"finish","text":"done","stopReason":"tool_use"}')
  assert.equal(result.text, 'done')
  assert.equal(result.stopReason, 'tool_use')
})

test('the line-incremental parser holds a partial line back until it is complete', () => {
  const parser = new ZcodeStreamParser()
  const first = parser.pushChunk('{"type":"text","te')
  assert.deepEqual(first, [], 'half a frame must never be classified')

  const second = parser.pushChunk('xt":"split across chunks"}\n')
  assert.deepEqual(second, [{ kind: 'text', text: 'split across chunks' }])
  assert.equal(parser.textLength, 'split across chunks'.length)

  // A trailing line without a newline only surfaces on flush.
  assert.deepEqual(parser.pushChunk('{"type":"text","text":"tail"}'), [])
  assert.deepEqual(parser.flush(), [{ kind: 'text', text: 'tail' }])
  assert.deepEqual(parser.flush(), [], 'flushing twice yields nothing')
})

test('the parser keeps every frame it saw and a bounded raw preview', () => {
  const parser = new ZcodeStreamParser()
  const line = `${JSON.stringify({ type: 'text', text: 'y'.repeat(300) })}\n`
  parser.pushChunk(line.repeat(5))
  assert.equal(parser.frames.length, 5)
  assert.ok(parser.rawPreview.length <= PARSE_PREVIEW_MAX_CHARS)
})

test('a non-JSON line is unknown, and unknown lines alone never become text', () => {
  const parser = new ZcodeStreamParser()
  assert.deepEqual(parser.pushLine('INFO starting up'), [{ kind: 'unknown', raw: 'INFO starting up' }])
  // Diagnostics printed around a real answer must not fail the run…
  assert.equal(parseStdout('INFO starting up\n{"type":"text","text":"real"}\n').text, 'real')
  // …but diagnostics with no answer behind them must not become an empty success.
  assert.throws(
    () => parseStdout('INFO starting up\nINFO still starting\n'),
    error => isZcodeError(error) && error.code === 'ZCODE_PARSE',
  )
})

test('classifyJsonValue handles arrays, primitives and untyped objects', () => {
  assert.deepEqual(classifyJsonValue([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), [
    { kind: 'text', text: 'a' },
    { kind: 'text', text: 'b' },
  ])
  assert.deepEqual(classifyJsonValue(7), [{ kind: 'unknown', raw: '7' }])
  assert.deepEqual(classifyJsonValue({ usage: { input_tokens: 1, output_tokens: 2 } }), [
    { kind: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
  ])
  assert.equal(classifyJsonValue({ error: { message: 'boom' } })[0].kind, 'error')
})

test('frame helpers apply the documented fallback order', () => {
  assert.equal(frameText({ text: 'first', content: 'second' }), 'first')
  assert.equal(frameText({ content: [{ type: 'text', text: 'nested' }] }), 'nested')
  assert.equal(frameText({ output_text: 'alt' }), 'alt')
  assert.equal(frameText({ type: 'text' }), undefined)

  assert.equal(frameSessionId({ session_id: 'sess_a' }), 'sess_a')
  assert.equal(frameSessionId({ session: { id: 'sess_b' } }), 'sess_b')
  // A non-`sess_` id is never adopted: the CLI would reject it on --resume.
  assert.equal(frameSessionId({ sessionId: 'not-a-session' }), undefined)
  assert.equal(frameSessionId({ sessionId: `${ZCODE_SESSION_ID_PREFIX}` }), `${ZCODE_SESSION_ID_PREFIX}`)

  assert.deepEqual(frameUsage({ prompt_tokens: 3, completion_tokens: 4 }), { inputTokens: 3, outputTokens: 4 })
  // Both counters are required: a one-sided report is dropped rather than shown as zero.
  assert.equal(frameUsage({ input_tokens: 3 }), undefined)
})

test('a runaway stream keeps a bounded frame window instead of growing without limit', () => {
  const parser = new ZcodeStreamParser(300)
  for (let index = 0; index < 1_000; index += 1) {
    parser.pushLine(JSON.stringify({ type: 'text_delta', text: `f${index}` }))
  }

  const frames = parser.frames
  assert.equal(frames.length, 300, 'retention must be capped')
  assert.equal(parser.frameCount, 1_000, 'every frame is still counted')
  assert.equal(parser.droppedFrameCount, 700)
  // The head keeps the session/usage header; the tail keeps finish/error frames.
  assert.equal(frameText(frames[0]), 'f0')
  assert.equal(frameText(frames.at(-1)), 'f999')
  assert.equal(frames.some(frame => frameText(frame) === 'f500'), false, 'the middle window is dropped')
})
