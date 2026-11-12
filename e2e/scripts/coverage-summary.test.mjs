// node --test: the merge logic of coverage-summary.mjs on small lcov fixtures.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_EXCLUDE,
  e2eGains,
  filterFiles,
  mergeCoverage,
  normalisePath,
  parseLcov,
  renderMarkdown,
  totals,
} from './coverage-summary.mjs'

const lcov = (records) =>
  records
    .map(([file, lines]) =>
      [`SF:${file}`, ...Object.entries(lines).map(([l, h]) => `DA:${l},${h}`), 'end_of_record'].join('\n'),
    )
    .join('\n')

test('normalisePath maps jest, monocart and absolute paths to app/...', () => {
  assert.equal(normalisePath('src\\ar\\geo.ts'), 'app/src/ar/geo.ts')
  assert.equal(normalisePath('app\\_layout.tsx'), 'app/app/_layout.tsx')
  assert.equal(normalisePath('app/app/_layout.tsx'), 'app/app/_layout.tsx')
  assert.equal(normalisePath('app/src/ar/geo.ts'), 'app/src/ar/geo.ts')
  assert.equal(normalisePath('/src/state/store.ts'), 'app/src/state/store.ts')
  assert.equal(normalisePath('/home/runner/work/skylens/skylens/app/app/map.tsx'), 'app/app/map.tsx')
  assert.equal(normalisePath('C:\\r\\skylens\\app\\src\\api\\client.ts'), 'app/src/api/client.ts')
  assert.equal(normalisePath('node_modules/leaflet/dist/leaflet-src.js'), 'node_modules/leaflet/dist/leaflet-src.js')
})

test('parseLcov merges repeated records of one file', () => {
  const files = parseLcov(
    lcov([
      ['src/a.ts', { 1: 0, 2: 3 }],
      ['src/a.ts', { 1: 1, 3: 0 }],
    ]),
  )
  assert.deepEqual(
    [...files.get('app/src/a.ts')],
    [
      [1, true],
      [2, true],
      [3, false],
    ],
  )
})

test('merge: covered if either side covers; one-sided lines keep their status', () => {
  const unit = parseLcov(
    lcov([
      ['src/a.ts', { 1: 1, 2: 0, 3: 0 }],
      ['src/u.ts', { 1: 0 }],
    ]),
  )
  const e2e = parseLcov(
    lcov([
      ['app/src/a.ts', { 2: 4, 3: 0, 9: 1 }],
      ['app/src/e.ts', { 1: 1, 2: 0 }],
    ]),
  )
  const merged = mergeCoverage(unit, e2e)
  assert.deepEqual(
    [...merged.get('app/src/a.ts')],
    [
      [1, true],
      [2, true],
      [3, false],
      [9, true],
    ],
  )
  assert.deepEqual([...merged.get('app/src/u.ts')], [[1, false]])
  assert.deepEqual(
    [...merged.get('app/src/e.ts')],
    [
      [1, true],
      [2, false],
    ],
  )
  assert.deepEqual(totals(merged), { covered: 4, total: 7, pct: (4 / 7) * 100 })
  assert.deepEqual(e2eGains(unit, e2e), [
    { file: 'app/src/a.ts', added: 2 },
    { file: 'app/src/e.ts', added: 1 },
  ])
})

test('filterFiles keeps app/ only and applies the default exclude', () => {
  const files = parseLcov(
    lcov([
      ['src/a.ts', { 1: 1 }],
      ['src/mock/feed.ts', { 1: 1 }],
      ['node_modules/x.js', { 1: 1 }],
    ]),
  )
  assert.deepEqual([...filterFiles(files, new RegExp(DEFAULT_EXCLUDE)).keys()], ['app/src/a.ts'])
})

test('renderMarkdown prints the three rows, n/a for a missing side', () => {
  const unit = parseLcov(lcov([['src/a.ts', { 1: 1, 2: 0 }]]))
  const md = renderMarkdown({ unit, e2e: null })
  assert.match(md, /\| Unit \(jest\) \| 1 \/ 2 \| 50\.0% \|/)
  assert.match(md, /\| E2E \(Playwright\) \| n\/a \| n\/a \|/)
  assert.match(md, /\| \*\*Combined\*\* \| 1 \/ 2 \| 50\.0% \|/)
  assert.match(md, /Approximate/)
})
