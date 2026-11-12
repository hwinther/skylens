#!/usr/bin/env node
/**
 * Unit + e2e coverage summary: merges jest's lcov (app/coverage/lcov.info) with the Playwright run's
 * browser coverage (e2e/monocart-coverage/lcov.info) per file and line, and prints a Markdown table
 * (Unit, E2E, Combined) plus the files where e2e adds the most lines.
 *
 *   node e2e/scripts/coverage-summary.mjs --unit app/coverage/lcov.info \
 *     --e2e e2e/monocart-coverage/lcov.info [--exclude '^app/src/mock/'] [--top 10]
 *
 * Paths are normalised to repo-relative app/... (jest writes them relative to app/, monocart as
 * app/... via playwright.ci.config.ts; absolute paths are cut at app/src or app/app). A line is covered
 * in Combined when either side covers it; a line only one side knows keeps that side's status. The
 * merge is approximate: istanbul counts statement lines, V8 (via monocart) counts every executable
 * source line, so the two sides do not agree on which lines exist.
 *
 * Dependency-free on purpose: the CI job runs it with plain node. Tests: node --test scripts/.
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** jest-config parity: collectCoverageFrom in app/jest.config.js excludes the demo feed. */
export const DEFAULT_EXCLUDE = '^app/src/mock/'

/** Repo-relative app/... for a path from either lcov; anything else is returned as-is. */
export function normalisePath(raw) {
  let path = raw.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (/^app\/(?:src|app)\//.test(path)) return path
  const nested = /(?:^|\/)app\/((?:src|app)\/.+)$/.exec(path)
  if (nested) return `app/${nested[1]}`
  path = path.replace(/^\/+/, '')
  if (/^(?:src|app)\//.test(path)) return `app/${path}`
  return path
}

/**
 * Parses lcov text into Map<file, Map<line, covered>>. Records of the same file (repeated SF blocks)
 * are merged, a line counting as covered if any record hit it.
 */
export function parseLcov(text) {
  const files = new Map()
  let lines = null
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      const file = normalisePath(raw.slice(3))
      lines = files.get(file) ?? new Map()
      files.set(file, lines)
    } else if (raw.startsWith('DA:') && lines) {
      const [line, hits] = raw.slice(3).split(',')
      const n = Number(line)
      if (Number.isInteger(n)) lines.set(n, (lines.get(n) ?? false) || Number(hits) > 0)
    } else if (raw === 'end_of_record') {
      lines = null
    }
  }
  return files
}

/** Drops files outside app/ and those matching `exclude` (a RegExp or null). */
export function filterFiles(files, exclude) {
  const out = new Map()
  for (const [file, lines] of files) {
    if (!file.startsWith('app/')) continue
    if (exclude && exclude.test(file)) continue
    out.set(file, lines)
  }
  return out
}

/** Per file: union of lines, covered when either side covers the line. */
export function mergeCoverage(unit, e2e) {
  const merged = new Map()
  for (const file of new Set([...unit.keys(), ...e2e.keys()])) {
    const a = unit.get(file) ?? new Map()
    const b = e2e.get(file) ?? new Map()
    const lines = new Map()
    for (const line of new Set([...a.keys(), ...b.keys()])) {
      lines.set(line, a.get(line) === true || b.get(line) === true)
    }
    merged.set(file, lines)
  }
  return merged
}

export function totals(files) {
  let covered = 0
  let total = 0
  for (const lines of files.values()) {
    for (const hit of lines.values()) {
      total += 1
      if (hit) covered += 1
    }
  }
  return { covered, total, pct: total === 0 ? 0 : (covered / total) * 100 }
}

/** Files ranked by lines e2e covers that unit does not (unit-uncovered or unknown to unit). */
export function e2eGains(unit, e2e, top = 10) {
  const gains = []
  for (const [file, lines] of e2e) {
    const u = unit.get(file)
    let added = 0
    for (const [line, hit] of lines) if (hit && u?.get(line) !== true) added += 1
    if (added > 0) gains.push({ file, added })
  }
  gains.sort((x, y) => y.added - x.added || x.file.localeCompare(y.file))
  return gains.slice(0, top)
}

const pct = (t) => `${t.pct.toFixed(1)}%`
const row = (name, t) => (t ? `| ${name} | ${t.covered} / ${t.total} | ${pct(t)} |` : `| ${name} | n/a | n/a |`)

/** The Markdown summary. `unit`/`e2e` are filtered file maps, or null when that lcov is missing. */
export function renderMarkdown({ unit, e2e, top = 10 }) {
  const u = unit ? totals(unit) : null
  const e = e2e ? totals(e2e) : null
  const c = totals(mergeCoverage(unit ?? new Map(), e2e ?? new Map()))
  const out = [
    '### Coverage: unit + e2e (lines)',
    '',
    '| Suite | Lines covered | % |',
    '| --- | ---: | ---: |',
    row('Unit (jest)', u),
    row('E2E (Playwright)', e),
    row('**Combined**', c),
    '',
    '_Approximate: jest/istanbul counts statement lines, the e2e side counts V8 lines through the web',
    "bundle's source maps. Combined takes, per file and line, covered if either side covers it; a line",
    "only one side knows keeps that side's status._",
  ]
  if (unit && e2e) {
    const gains = e2eGains(unit, e2e, top)
    if (gains.length > 0) {
      const unitByFile = (file) => totals(new Map([[file, unit.get(file) ?? new Map()]]))
      const merged = mergeCoverage(unit, e2e)
      out.push('', '<details><summary>Where e2e adds the most</summary>', '')
      out.push('| File | Lines added by e2e | Unit | Combined |', '| --- | ---: | ---: | ---: |')
      for (const { file, added } of gains) {
        const before = unitByFile(file)
        const after = totals(new Map([[file, merged.get(file)]]))
        out.push(`| \`${file}\` | ${added} | ${before.total ? pct(before) : 'n/a'} | ${pct(after)} |`)
      }
      out.push('', '</details>')
    }
  }
  return `${out.join('\n')}\n`
}

function readLcov(path) {
  if (!path || !fs.existsSync(path)) return null
  return parseLcov(fs.readFileSync(path, 'utf8'))
}

function parseArgs(argv) {
  const args = { exclude: DEFAULT_EXCLUDE, top: 10 }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--unit') args.unit = value
    else if (key === '--e2e') args.e2e = value
    else if (key === '--exclude') args.exclude = value
    else if (key === '--top') args.top = Number(value)
    else throw new Error(`Unknown argument: ${key}`)
    i += 1
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const exclude = args.exclude ? new RegExp(args.exclude) : null
  const unitRaw = readLcov(args.unit)
  const e2eRaw = readLcov(args.e2e)
  if (!unitRaw && !e2eRaw) {
    console.error(`No lcov found (--unit ${args.unit ?? '-'}, --e2e ${args.e2e ?? '-'})`)
    process.exit(1)
  }
  const unit = unitRaw && filterFiles(unitRaw, exclude)
  const e2e = e2eRaw && filterFiles(e2eRaw, exclude)
  process.stdout.write(renderMarkdown({ unit, e2e, top: args.top }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
