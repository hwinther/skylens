/**
 * The non-modal detail card (app/src/components/Sheet.tsx): no scrim, the scene behind stays
 * interactive, and tapping another object swaps the card's content without closing it first.
 *
 * - Desktop (>= 900 px): a ~360 px side panel docked right, always showing the full content.
 * - Phone: a compact card at the bottom. Collapsed it shows the title + a one-line summary (and the
 *   quick actions); the chevron expands it to the full content and collapses it again.
 *
 * Driven from the List tab, whose aircraft rows are always on screen once the replay is flowing.
 */

import { expect, type Page, test } from './fixtures'

async function openFirstAircraft(page: Page): Promise<string> {
  await page.goto('/list')
  const rows = page.locator('[data-testid^="list-ac-"]')
  await expect(rows.nth(1), 'the replay should list at least two aircraft').toBeVisible({ timeout: 30_000 })
  await rows.first().click()
  const title = page.getByTestId('detail-title')
  await expect(title).toBeVisible({ timeout: 15_000 })
  return ((await title.textContent()) ?? '').trim()
}

test.describe('desktop: side panel', () => {
  test('docks right, keeps the list interactive, swaps content and closes on Escape', async ({ page }) => {
    const firstTitle = await openFirstAircraft(page)

    const card = page.getByTestId('detail-card')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('aria-label', 'Aircraft details')
    // Full content right away: no collapsed state and no expand toggle on a wide screen.
    await expect(page.getByTestId('detail-card-body')).toBeVisible()
    await expect(page.getByTestId('detail-cockpit')).toBeVisible()
    await expect(page.getByTestId('detail-card-toggle')).toHaveCount(0)

    // Docked to the right edge, ~360 px wide, leaving the rest of the list uncovered.
    const viewport = page.viewportSize()!
    const box = (await card.boundingBox())!
    expect(box.width).toBeGreaterThan(300)
    expect(box.width).toBeLessThan(420)
    expect(Math.round(box.x + box.width)).toBe(viewport.width)

    // The list behind still scrolls (no scrim swallowing input)...
    const scroll = page.getByTestId('list-scroll')
    const listBox = (await scroll.boundingBox())!
    await page.mouse.move(listBox.x + 200, listBox.y + listBox.height / 2)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await scroll.evaluate((el) => el.scrollTo(0, 0))

    // ...and a tap on another row swaps the card's content without closing it first.
    await page.locator('[data-testid^="list-ac-"]').nth(1).click()
    await expect(page.getByTestId('detail-title')).not.toHaveText(firstTitle, { timeout: 15_000 })
    await expect(page.getByTestId('detail-card')).toHaveCount(1)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('detail-card')).toHaveCount(0)
  })
})

test.describe('phone: compact card', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('opens collapsed, expands, collapses and closes; the list stays tappable', async ({ page }) => {
    const firstTitle = await openFirstAircraft(page)

    const card = page.getByTestId('detail-card')
    const toggle = page.getByTestId('detail-card-toggle')
    const body = page.getByTestId('detail-card-body')

    // Collapsed: title + one-line summary, a short card at the bottom, full content hidden.
    await expect(page.getByTestId('detail-card-summary')).toBeVisible()
    await expect(body).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const box = (await card.boundingBox())!
    expect(box.height, 'the collapsed card stays compact').toBeLessThan(180)
    expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height / 2)

    // The scene behind still receives input: tapping another row swaps the collapsed card's content.
    await page.locator('[data-testid^="list-ac-"]').nth(1).click()
    await expect(page.getByTestId('detail-title')).not.toHaveText(firstTitle, { timeout: 15_000 })
    await expect(card).toHaveCount(1)
    await expect(body).toHaveCount(0)

    // Expand: the full content shows (rows such as Altitude live in the body), the title stays.
    await toggle.click()
    await expect(body).toBeVisible()
    await expect(body.getByText('Altitude')).toBeVisible()
    await expect(page.getByTestId('detail-title')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('detail-card-summary')).toHaveCount(0)

    // Collapse again.
    await toggle.click()
    await expect(body).toHaveCount(0)
    await expect(page.getByTestId('detail-card-summary')).toBeVisible()

    // Close.
    await page.getByTestId('detail-card-close').click()
    await expect(card).toHaveCount(0)
  })
})
