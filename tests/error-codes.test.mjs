/**
 * Frozen error surface of this provider: the code list, the stderr classifier
 * and the two guards.
 *
 * The fixtures at the top are quoted from `office-hours.md` §5.1 — they are the
 * only real ZCode stderr this project has ever captured (the original `tmp/`
 * artefacts were destroyed, see `design.md` L2). They are inlined here on
 * purpose: a `tests/fixtures/` tree would drift out of sight of the assertions
 * that depend on it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DIAGNOSTIC_MAX_CHARS,
  STDERR_TAIL_MAX_CHARS,
  ZCODE_ERROR_CODES,
  boundDiagnostic,
  classifyStderr,
  boundStderrTail,
  isZcodeError,
  isZcodeErrorCode,
  sanitizeSecrets,
  ZcodeError,
} from '../lib/provider/error-codes.js'

/**
 * Verbatim stderr of one quota-blocked run (exit code 1, stdout empty).
 *
 * Source: `office-hours.md` §5.1, capture `tmp/02-p-json-guarded-fulllenv.log`,
 * 2933 bytes, 2026-10-24 01:13. The three-bracket prefix is the whole reason
 * the classifier parses stderr text instead of waiting for JSON: the failure
 * path emits no JSON at all.
 */
const QUOTA_STDERR = `ProviderBusinessError: [1309][您的GLM Coding Plan套餐已到期，暂无法使用，前往官方续订后即可恢复https://bigmodel.cn/claude-code。][2026102401123552bbdbe6a99a4f3d]
    at detectProviderBusinessError (zcode.cjs:2132:14232)
    at async postToApi (zcode.cjs:2085:22186)
    at async _6s.doStream (zcode.cjs:2086:51208)
    at async _retryWithExponentialBackoff (zcode.cjs:2159:5143)
code: 'PROVIDER_BUSINESS_ERROR', isProviderBusinessError: true, providerCode: '1309',
providerId: 'bigmodel-personal', providerKind: 'anthropic', responseStatus: 429,
error.type: 'rate_limit_error', request-id: '2026102401123552bbdbe6a99a4f3d',
date: 'Fri, 23 Oct 2026 17:12:35 GMT', 'x-process-time': '0.298755'`

/** The same prefix shape with the other two provider codes the派单 names. */
const RATE_LIMIT_STDERR = 'ProviderBusinessError: [3007][请求过于频繁，请稍后重试][2026102401123552bbdbe6a99a4f3e]'
const PERMISSION_STDERR = 'ProviderBusinessError: [3012][unusual activity detected][2026102401123552bbdbe6a99a4f3f]'

test('ZCODE_ERROR_CODES is the frozen list of 17 unique string codes', () => {
  assert.equal(ZCODE_ERROR_CODES.length, 17)
  assert.equal(new Set(ZCODE_ERROR_CODES).size, 17)
  for (const code of ZCODE_ERROR_CODES) {
    assert.equal(typeof code, 'string')
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
    assert.equal(isZcodeErrorCode(code), true)
  }
  // The two codes B5 needs are part of the same frozen list.
  assert.ok(ZCODE_ERROR_CODES.includes('PERMISSION_REQUIRED'))
  assert.ok(ZCODE_ERROR_CODES.includes('UNSUPPORTED_TOOLS'))
  // Round-1 review additions: contract refusals, backpressure/output limits, and
  // the fail-closed workspace lookup.
  for (const code of [
    'UNSUPPORTED_OPTION',
    'UNSUPPORTED_CONTENT',
    'ZCODE_BUSY',
    'ZCODE_OUTPUT_TOO_LARGE',
    'WORKSPACE_UNAVAILABLE',
  ]) {
    assert.ok(ZCODE_ERROR_CODES.includes(code), `missing ${code}`)
  }
  assert.equal(isZcodeErrorCode('NOT_A_CODE'), false)
  assert.equal(isZcodeErrorCode(undefined), false)
})

test('diagnostics are sanitized before they leave the process', () => {
  const openaiStyle = `sk-${'a'.repeat(24)}`
  const raw = [
    'Authorization: Bearer abc.def-123',
    'GET https://api.example/x?token=tk_live_987654&sig=sg_123456 failed',
    'GET https://api.example/y?a=1&sig=sg_123456 failed',
    `upstream ${openaiStyle} leaked`,
  ].join('\n')

  const clean = sanitizeSecrets(raw)
  assert.doesNotMatch(clean, /abc\.def-123/)
  assert.doesNotMatch(clean, /tk_live_987654/)
  assert.doesNotMatch(clean, /sg_123456/)
  assert.doesNotMatch(clean, new RegExp(openaiStyle))
  assert.match(clean, /Bearer \*\*\*/)
  assert.match(clean, /token=\*\*\*/)
  assert.match(clean, /sig=\*\*\*/)
  assert.match(clean, /upstream \*\*\* leaked/)
})

test('diagnostic text is capped at 4 KiB and keeps its tail', () => {
  const long = `${'a'.repeat(DIAGNOSTIC_MAX_CHARS)}TAIL`
  const bounded = boundDiagnostic(long)
  assert.ok(bounded.length <= DIAGNOSTIC_MAX_CHARS, `still ${bounded.length} chars`)
  assert.ok(bounded.startsWith('…'))
  assert.ok(bounded.endsWith('TAIL'))

  // The cap also applies to a ZcodeError's provider message and stderr tail.
  const error = new ZcodeError('ZCODE_EXIT', 'headline', {
    providerMessage: 'p'.repeat(9_000),
    stderrTail: 'x'.repeat(9_000),
  })
  assert.ok((error.providerMessage ?? '').length <= DIAGNOSTIC_MAX_CHARS)
  assert.ok((error.stderrTail ?? '').length <= STDERR_TAIL_MAX_CHARS)
})

test('a ZcodeError scrubs its own message and provider message, not just the helper', () => {
  // The helper is tested directly above; this covers the wiring, so a future
  // refactor that drops the call inside `boundDiagnostic` turns this red.
  const secret = `sk-${'b'.repeat(24)}`
  const error = new ZcodeError('ZCODE_EXIT', 'upstream said Bearer eyes-only-token', {
    providerMessage: `Authorization: Bearer eyes-only-token\nGET /v1?token=tk_live_987654\n${secret}`,
    stderrTail: `Bearer eyes-only-token\n${secret}`,
  })

  assert.doesNotMatch(error.message, /eyes-only-token/)
  assert.doesNotMatch(error.providerMessage ?? '', /eyes-only-token|tk_live_987654/)
  assert.doesNotMatch(error.providerMessage ?? '', new RegExp(secret))
  assert.doesNotMatch(error.stderrTail ?? '', /eyes-only-token/)
  assert.doesNotMatch(error.stderrTail ?? '', new RegExp(secret))
})

test('AC6: 1309 classifies as QUOTA and keeps providerCode + request-id', () => {
  const error = classifyStderr(QUOTA_STDERR, { exitCode: 1 })
  assert.ok(isZcodeError(error))
  assert.equal(error.code, 'QUOTA')
  assert.equal(error.providerCode, 1309)
  assert.match(error.providerMessage ?? '', /套餐已到期/)
  assert.equal(error.requestId, '2026102401123552bbdbe6a99a4f3d')
  // `responseStatus: 429` is the object-field shape the classifier reads: the
  // word is glued to `response`, which is exactly the shape a `\bstatus`
  // pattern silently dropped before W4 fixed it.
  assert.equal(error.responseStatus, 429)
  // The message is built by the classifier, not copied: it must name the
  // condition a user can act on, and keep the provider message attached.
  assert.match(error.message, /quota/i)
  assert.match(error.message, /套餐已到期/)
})

test('the status reader accepts HTTP, status and responseStatus shapes only', () => {
  const status = stderr => classifyStderr(stderr, { exitCode: 1 }).responseStatus

  // Shape 1: the bare transport line.
  assert.equal(status('HTTP 429 Too Many Requests'), 429)
  assert.equal(status('HTTP 401 Unauthorized'), 401)
  // Shape 2: the CLI's own wording, with and without `code`.
  assert.equal(status('status: 429'), 429)
  assert.equal(status('status code 429'), 429)
  assert.equal(status('Status Code: 502'), 502)
  // Shape 3: the dump field, `:` or `=` and either spacing.
  assert.equal(status('responseStatus: 429'), 429)
  assert.equal(status('responseStatus=429'), 429)
  assert.equal(status('responseStatus = 429'), 429)
  // The real capture, byte for byte (see QUOTA_STDERR): its 429 sits behind a
  // fixed-width provider code, so the reader must not pick up `1309` instead.
  assert.equal(status(QUOTA_STDERR), 429)

  // Strictness kept: three digits with a word boundary, punctuation-only
  // separators, and no match on an unrelated four-digit provider code.
  assert.equal(status('responseStatus: 4290'), undefined)
  assert.equal(status('status: 42'), undefined)
  assert.equal(status('status of the run: 500'), undefined)
  assert.equal(status('providerCode: 1309'), undefined)
})

test('3007 classifies as RATE_LIMIT and 3012 as PERMISSION_REQUIRED', () => {
  const rateLimited = classifyStderr(RATE_LIMIT_STDERR, { exitCode: 1 })
  assert.equal(rateLimited.code, 'RATE_LIMIT')
  assert.equal(rateLimited.providerCode, 3007)
  assert.equal(rateLimited.requestId, '2026102401123552bbdbe6a99a4f3e')

  const permission = classifyStderr(PERMISSION_STDERR, { exitCode: 1 })
  assert.equal(permission.code, 'PERMISSION_REQUIRED')
  assert.equal(permission.providerCode, 3012)
  assert.equal(permission.requestId, '2026102401123552bbdbe6a99a4f3f')
})

test('HTTP 401 and identity wording classify as AUTH', () => {
  const byStatus = classifyStderr('HTTP 401 Unauthorized', { exitCode: 1 })
  assert.equal(byStatus.code, 'AUTH')
  assert.equal(byStatus.responseStatus, 401)

  const byMessage = classifyStderr('请求身份无效，请重新登录', { exitCode: 1 })
  assert.equal(byMessage.code, 'AUTH')
})

test('an HTTP status is read when the CLI prints one', () => {
  const rateLimited = classifyStderr('HTTP 429 Too Many Requests', { exitCode: 1 })
  assert.equal(rateLimited.responseStatus, 429)
  assert.equal(rateLimited.code, 'RATE_LIMIT')
})

test('a broken environment contract is named, not blamed on the model', () => {
  const missingConfig = classifyStderr('Error: 无法定位 CLI ZCode Built-in Provider Config', { exitCode: 1 })
  assert.equal(missingConfig.code, 'ZCODE_ENV_MISSING')

  const bothRequired = classifyStderr('Error: 必须同时提供 built-in 与 personal provider 配置', { exitCode: 1 })
  assert.equal(bothRequired.code, 'ZCODE_ENV_MISSING')
})

test('a transport failure stays retryable as ZCODE_UNKNOWN', () => {
  const transport = classifyStderr('Cannot connect to API: AggregateError', { exitCode: 1 })
  assert.equal(transport.code, 'ZCODE_UNKNOWN')
})

test('an unexplained non-zero exit classifies as ZCODE_EXIT and keeps the tail', () => {
  const error = classifyStderr('something went wrong in the worker thread', { exitCode: 3 })
  assert.equal(error.code, 'ZCODE_EXIT')
  assert.equal(error.providerCode, undefined)
  assert.match(error.message, /3/)
  assert.match(error.stderrTail ?? '', /worker thread/)
})

test('the --verbose Cause line is only used when the caller opted in', () => {
  const stderr = 'boom\nCause: ECONNRESET while streaming from bigmodel'
  assert.match(classifyStderr(stderr, { exitCode: 1, verbose: true }).message, /ECONNRESET/)
  assert.doesNotMatch(classifyStderr(stderr, { exitCode: 1 }).message, /ECONNRESET/)
})

test('boundStderrTail bounds the capture and drops blanks', () => {
  assert.equal(boundStderrTail(undefined), undefined)
  assert.equal(boundStderrTail('   \n\t '), undefined)
  assert.equal(boundStderrTail('  short  '), 'short')

  const long = 'x'.repeat(STDERR_TAIL_MAX_CHARS + 500)
  const bounded = boundStderrTail(long)
  assert.equal(bounded?.length, STDERR_TAIL_MAX_CHARS)
  // The cut keeps the end of the capture: that is where a stack trace names the
  // cause, and the ellipsis is counted inside the budget.
  assert.ok(bounded?.startsWith('…'))
  assert.ok(bounded?.endsWith('x'))
})

test('a ZcodeError reports the code it was built with and its diagnostic fields', () => {
  const error = new ZcodeError('TIMEOUT', 'took too long', { cause: new Error('inner') })
  assert.equal(error.code, 'TIMEOUT')
  assert.equal(error.name, 'ZcodeError')
  assert.equal(error.providerCode, undefined)
  assert.ok(isZcodeError(error))
  assert.equal(isZcodeError(new Error('plain')), false)
})
