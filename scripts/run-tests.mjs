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
const TEXT_ROOTS = ['src', 'tests', 'scripts']
/** Root-level text files AC11 covers, when present. */
const TEXT_FILES = ['package.json', 'tsconfig.json', 'README.md', 'cordis.patch.yml']
/** Extensions treated as text. */
const TEXT_EXTENSIONS = ['.ts', '.mjs', '.js', '.json', '.md', '.yml']

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

const files = readdirSync(testsDir)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join(testsDir, name))

if (files.length === 0) {
  process.stderr.write('No tests/*.test.mjs files were found — refusing to report success.\n')
  process.exit(1)
}

// `--test-reporter=spec` keeps the per-test lines readable when the suite grows.
const ok = step('tests', ['--test', '--test-reporter=spec', ...files])
process.stdout.write(ok ? '\nall gates passed\n' : '\nthe gate is red\n')
process.exit(ok ? 0 : 1)
