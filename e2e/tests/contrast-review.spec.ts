// TEMPORARY (contrast round): records every element axe's color-contrast rule flags, with its colours
// and a cropped screenshot, plus crops of the elements flagged before the colour change, for a
// before/after review. Not a check: it never fails on findings. Removed before the PR is merged.
import fs from 'node:fs/promises'

import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'

import { expect, test } from './fixtures'

// Flagged by the run before the colour change: the tab labels, found by structure, since
// react-native-web's class names change with the colour.
const REVIEW = ['a[href="/"] [dir="auto"]', 'a[href$="map"] [dir="auto"]', 'a[href$="settings"] [dir="auto"]']

async function crop(page: Page, selector: string, path: string): Promise<void> {
  const element = page.locator(selector).first()
  await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined)
  const box = await element.boundingBox({ timeout: 5000 }).catch(() => null)
  if (!box || box.width === 0 || box.height === 0) return
  const pad = 24
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  const clip = {
    x,
    y,
    width: Math.min(viewport.width - x, box.width + 2 * pad),
    height: Math.min(viewport.height - y, box.height + 2 * pad),
  }
  await page.screenshot({ clip, path })
}

async function contrastReview(page: Page, testInfo: TestInfo, name: string, review: string[]): Promise<void> {
  const results = await new AxeBuilder({ page })
    .options({ preload: false, runOnly: { type: 'rule', values: ['color-contrast'] } })
    .analyze()
  const dir = testInfo.outputPath('contrast')
  await fs.mkdir(dir, { recursive: true })
  const rows: Record<string, unknown>[] = []
  const nodes = results.violations.flatMap((violation) => violation.nodes)
  for (const [index, node] of nodes.entries()) {
    const selector = node.target.join(' ')
    rows.push({ index, selector, html: node.html, ...(node.any[0]?.data as object) })
    await crop(page, selector, `${dir}/${name}-${index}.png`)
  }
  await fs.writeFile(`${dir}/${name}.json`, JSON.stringify(rows, null, 2))
  for (const [index, selector] of review.entries()) await crop(page, selector, `${dir}/${name}-review-${index}.png`)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ fullPage: true, path: `${dir}/${name}-page.png` })
}

test('contrast review: list', async ({ page }, testInfo) => {
  await page.goto('/list')
  await expect(page.locator('[data-testid^="list-ac-"]').first()).toBeVisible({ timeout: 30_000 })
  await contrastReview(page, testInfo, 'list', REVIEW)
})
