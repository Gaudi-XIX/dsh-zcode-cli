#!/usr/bin/env node
/**
 * One command for the whole gate: typecheck, build, then every `*.test.mjs`.
 *
 * Why a script instead of two npm scripts chained with `&&`: the build has to
 * happen *before* the tests (they import `lib/`, never `src/`), and a silent
 * `&&` chain gives no way to say which half failed. Every step is spawned with
 * `process.execPath`, so nothing depends on a shell, on `.bin` shims, or on how
 * Windows resolves `tsc.cmd`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const testsDir = join(root, 'tests')

/**
 * Run one step with inherited stdio.
 *
 * @param {string} label - Human-readable step name.
 * @param {readonly string[]} args - Arguments for `node`.
 * @returns {boolean} Whether the step exited 0.
 */
function step(label, args) {
  process.stdout.write(`\n── ${label}\n`)
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined && result.error !== null) {
    process.stderr.write(`${label} could not start: ${result.error.message}\n`)
    return false
  }
  if (result.status !== 0) {
    process.stderr.write(`\n${label} failed (exit ${String(result.status)})\n`)
    return false
  }
  return true
}

if (!existsSync(tsc)) {
  process.stderr.write(
    'TypeScript is not installed in this checkout.\n'
    + 'Run `npm install --ignore-scripts` first (the package keeps no dependencies of its own).\n',
  )
  process.exit(1)
}

/** Directories whose text files AC11 covers. */
const TEXT_ROOTS = ['src', 'tests', 'scripts', 'docs']
/** Root-level text files AC11 covers, when present. */
const TEXT_FILES = ['package.json', 'tsconfig.json', 'README.md', 'cordis.patch.yml']
/** Extensions treated as text. */
const TEXT_EXTENSIONS = ['.ts', '.mjs', '.js', '.json', '.md', '.yml']

/**
 * The test corpus, named explicitly.
 *
 * Discovery is recursive, so a test dropped into `tests/unit/` still runs; the
 * explicit set is what makes a *missing* or *renamed* file a gate failure
 * instead of a quietly smaller run. Keep them in sync with the count declared in
 * `docs/dsh-provider-contract.md` — the assertion below cross-checks the two.
 */
const EXPECTED_TEST_FILES = [
  'adapter.test.mjs',
  'argv.test.mjs',
  'doctor.test.mjs',
  'env.test.mjs',
  'error-codes.test.mjs',
  'parser.test.mjs',
  'process.test.mjs',
  'register.test.mjs',
  'session.test.mjs',
]

/**
 * Recursively collect `*.test.mjs` under the tests directory.
 *
 * @param {string} directory - Absolute directory to walk.
 * @returns {string[]} Absolute paths, slash-normalised for comparison.
 */
function discoverTests(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...discoverTests(full))
    } else if (entry.name.endsWith('.test.mjs')) {
      found.push(full)
    }
  }
  return found
}

/**
 * Read the declared test count out of the contract document.
 *
 * The doc line is the human-readable declaration; parsing it keeps the gate from
 * silently drifting away from the document reviewers read.
 *
 * @returns {number | undefined} The declared count, when the line is present.
 */
function declaredTestCount() {
  const document = join(root, 'docs', 'dsh-provider-contract.md')
  if (!existsSync(document)) return undefined
  const match = readFileSync(document, 'utf8').match(/测试面：[^\n]*共 \*\*(\d+)\*\*/)
  return match === undefined || match === null ? undefined : Number.parseInt(match[1], 10)
}

/**
 * The controlled-file count the contract doc declares, when present.
 *
 * @returns {number | undefined} The declared count.
 */
function declaredControlledFileCount() {
  const document = join(root, 'docs', 'dsh-provider-contract.md')
  if (!existsSync(document)) return undefined
  const match = readFileSync(document, 'utf8').match(/受控文件：[^\n]*共 \*\*(\d+)\*\*/)
  return match === undefined || match === null ? undefined : Number.parseInt(match[1], 10)
}

/**
 * Count the tracked files. `git` is the single source of truth here: a new file
 * that nobody staged is, by definition, not part of the controlled set.
 *
 * @returns {number | undefined} `undefined` when git cannot answer.
 */
function actualControlledFileCount() {
  const result = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) return undefined
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length
}

/**
 * Fail when a published entry point points at a file the build did not produce.
 *
 * AC1 is otherwise unguarded: `main`/`types`/`exports` are strings in JSON, and a
 * stale one only surfaces when the host fails to load the plugin.
 *
 * @returns {string[]} One message per broken target, empty when clean.
 */
function findBrokenEntryPoints() {
  const problems = []
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const targets = []
  if (typeof manifest.main === 'string') targets.push(['main', manifest.main])
  if (typeof manifest.types === 'string') targets.push(['types', manifest.types])
  const walkExports = (value, where) => {
    if (typeof value === 'string') targets.push([where, value])
    else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) walkExports(nested, `${where}.${key}`)
    }
  }
  walkExports(manifest.exports, 'exports')
  walkExports(manifest.dsh?.bundle, 'dsh.bundle')
  for (const [label, target] of targets) {
    // Node accepts both `lib/index.js` and `./lib/index.js` for `main`; only a
    // package-relative path is legitimate, so absolute paths and URLs fail.
    const relative = target.startsWith('./') ? target.slice(2) : target
    if (relative.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relative) || relative.includes('://')) {
      problems.push(`${label} must be a package-relative path, got ${target}`)
      continue
    }
    if (!existsSync(join(root, relative))) problems.push(`${label} points at missing ${target}`)
  }
  // AC10: the runtime dependency list is frozen at zero; a new entry here would
  // need its own review, so the gate refuses one rather than trusting a diff.
  const dependencies = manifest.dependencies ?? {}
  if (Object.keys(dependencies).length > 0) {
    problems.push(`dependencies must stay empty, found ${Object.keys(dependencies).join(', ')}`)
  }
  return problems
}

/**
 * AC11: every text file is LF-only and carries no BOM.
 *
 * Read as bytes, not as a string: `readFileSync(path, 'utf8')` would already
 * have converted a BOM into U+FEFF, which is exactly the byte sequence that has
 * to be caught. A committed CRLF turns every later diff of that file into a
 * whole-file rewrite, and a BOM breaks the shebang in `scripts/`.
 *
 * @returns {readonly string[]} One line per violation, empty when clean.
 */
function findLineEndingViolations() {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib') walk(full)
      } else if (TEXT_EXTENSIONS.includes(extname(entry.name))) {
        files.push(full)
      }
    }
  }
  for (const directory of TEXT_ROOTS) {
    if (existsSync(join(root, directory))) walk(join(root, directory))
  }
  for (const file of TEXT_FILES) {
    if (existsSync(join(root, file))) files.push(join(root, file))
  }

  const problems = []
  for (const file of files) {
    const bytes = readFileSync(file)
    const relative = file.slice(root.length + 1).replace(/\\/g, '/')
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      problems.push(`${relative}: starts with a UTF-8 BOM`)
    }
    if (bytes.includes('\r\n')) problems.push(`${relative}: contains CRLF line endings`)
  }
  return problems
}

process.stdout.write('\n── AC11 line endings\n')
const endingProblems = findLineEndingViolations()
if (endingProblems.length > 0) {
  for (const problem of endingProblems) process.stderr.write(`  ${problem}\n`)
  process.stderr.write(`\nAC11 failed: ${endingProblems.length} line-ending violation(s)\n`)
  process.exit(1)
}
process.stdout.write('  all text files are LF without BOM\n')

// `--noEmit` first: a type error is cheaper to read than the build output it
// would otherwise be buried in.
if (!step('typecheck', [tsc, '-p', 'tsconfig.json', '--noEmit'])) process.exit(1)
if (!step('build', [tsc, '-p', 'tsconfig.json'])) process.exit(1)

process.stdout.write('\n── package entry points\n')
const entryProblems = findBrokenEntryPoints()
if (entryProblems.length > 0) {
  for (const problem of entryProblems) process.stderr.write(`  ${problem}\n`)
  process.stderr.write(`\nentry-point check failed: ${entryProblems.length} problem(s)\n`)
  process.exit(1)
}
process.stdout.write('  main/types/exports and the bundle patch exist; dependencies stay empty\n')

process.stdout.write('\n── controlled file count\n')
const declaredFiles = declaredControlledFileCount()
const actualFiles = actualControlledFileCount()
if (actualFiles === undefined) {
  process.stdout.write('  git is unavailable in this checkout; count check skipped\n')
} else if (declaredFiles === undefined) {
  process.stderr.write(
    'docs/dsh-provider-contract.md is missing the "受控文件：… 共 **N**" declaration.\n',
  )
  process.exit(1)
} else if (declaredFiles !== actualFiles) {
  process.stderr.write(
    `controlled-file count drift: docs declare ${declaredFiles}, git tracks ${actualFiles}\n`,
  )
  process.exit(1)
} else {
  process.stdout.write(`  ${actualFiles} tracked files match the declaration\n`)
}

const discovered = discoverTests(testsDir)
const files = discovered.slice().sort()
const names = files.map(file => file.slice(testsDir.length + 1).replace(/\\/g, '/'))

if (files.length === 0) {
  process.stderr.write('No tests/**/*.test.mjs files were found — refusing to report success.\n')
  process.exit(1)
}

// The declared count and the real corpus must agree: a deleted or renamed test
// otherwise shrinks the gate silently, which is the failure mode this replaces.
const declared = declaredTestCount()
if (declared === undefined) {
  process.stderr.write(
    'docs/dsh-provider-contract.md is missing the "测试面：… 共 **N**" declaration; '
    + 'refusing to guess the expected test count.\n',
  )
  process.exit(1)
}
if (declared !== names.length) {
  process.stderr.write(
    `test count drift: docs declare ${declared}, tests/ holds ${names.length} (${names.join(', ')})\n`,
  )
  process.exit(1)
}

const missing = EXPECTED_TEST_FILES.filter(name => !names.includes(name))
const extra = names.filter(name => !EXPECTED_TEST_FILES.includes(name))
if (missing.length > 0 || extra.length > 0) {
  process.stderr.write(
    `test corpus drift: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]\n`,
  )
  process.exit(1)
}
process.stdout.write(`  ${names.length} test files match the declared corpus\n`)

// `--test-reporter=spec` keeps the per-test lines readable when the suite grows.
const ok = step('tests', ['--test', '--test-reporter=spec', ...files])
process.stdout.write(ok ? '\nall gates passed\n' : '\nthe gate is red\n')
process.exit(ok ? 0 : 1)
