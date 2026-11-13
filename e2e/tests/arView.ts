/**
 * Helpers for driving the AR view on desktop web (live mode at the fixture home, drag-to-look over the
 * synthetic horizon).
 *
 * The overlay redraws at ~20 fps, so right after a drag the labels can still be where the old pose put
 * them. Only trust what the page shows once the overlay has caught up: the compass marks and airport
 * labels are fixed on the sky, so their positions stop changing exactly when the drawn pose matches the
 * dragged one.
 */

import { expect, type Page } from './fixtures'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** One look at the overlay, taken after at least two more draws. */
interface OverlaySample {
  /** Positions of the sky-fixed marks: equal in two samples in a row = the overlay has settled. */
  layout: string
  /** Airport labels on screen, by ident. */
  airports: { ident: string; box: Box }[]
  /** With a `row`: an x on that row whose surroundings belong to the bare view (no label), else null. */
  freeX: number | null
}

async function sampleOverlay(page: Page, row: number | null): Promise<OverlaySample> {
  return page.evaluate(
    async ({ y, margin }) => {
      const t0 = performance.now()
      await new Promise<void>((done) => {
        const frame = () => (performance.now() - t0 >= 120 ? done() : requestAnimationFrame(frame))
        requestAnimationFrame(frame)
      })
      const marks = [...document.querySelectorAll('[data-testid^="compass-"], [data-testid^="ar-airport-"]')]
      const layout = marks
        .map((el) => {
          const r = el.getBoundingClientRect()
          return `${el.getAttribute('data-testid')}@${Math.round(r.left)},${Math.round(r.top)}`
        })
        .sort()
        .join(';')
      const airports = marks
        .filter((el) => /^ar-airport-(?!icon-)/.test(el.getAttribute('data-testid') ?? ''))
        .map((el) => {
          const r = el.getBoundingClientRect()
          return {
            ident: el.getAttribute('data-testid')!.slice('ar-airport-'.length),
            box: { x: r.left, y: r.top, width: r.width, height: r.height },
          }
        })
      if (y === null) return { layout, airports, freeX: null }
      const owner = (px: number, py: number) =>
        document.elementFromPoint(px, py)?.closest('[data-testid]')?.getAttribute('data-testid')
      const around: [number, number][] = [
        [0, 0],
        [-margin, 0],
        [margin, 0],
        [0, -margin],
        [0, margin],
      ]
      const free = (px: number) => around.every(([dx, dy]) => owner(px + dx, y + dy) === 'ar-identify-touch')
      const mid = window.innerWidth / 2
      for (let d = 0; d < mid - margin; d += 8) {
        if (free(mid + d)) return { layout, airports, freeX: mid + d }
        if (free(mid - d)) return { layout, airports, freeX: mid - d }
      }
      return { layout, airports, freeX: null }
    },
    { y: row, margin: 24 },
  )
}

/**
 * Sample the overlay until it has settled and `pick` finds what the caller needs in it (`what` says
 * what that is, for the failure message).
 */
async function settled<T>(
  page: Page,
  row: number | null,
  pick: (s: OverlaySample) => T | null,
  what: string,
): Promise<T> {
  let previousLayout: string | null = null
  let picked: T | null = null
  await expect(async () => {
    const sample = await sampleOverlay(page, row)
    const isSettled = sample.layout === previousLayout
    previousLayout = sample.layout
    picked = pick(sample)
    expect(isSettled, 'the overlay should have caught up with the pose').toBe(true)
    expect(picked, what).not.toBeNull()
  }).toPass({ timeout: 10_000, intervals: [0] })
  return picked!
}

/**
 * A point on the row at height `y` that belongs to the bare view: identify's long-press catcher, not a
 * label. Airport labels sit right on the horizon and replayed aircraft drift across the sky; they are
 * tap targets above the catcher, so a hold on one never reaches identify. Where they are depends on the
 * replay's timing, so search outward from the middle for a free spot, with a margin around it.
 */
export async function freePoint(page: Page, y: number): Promise<{ x: number; y: number }> {
  return settled(
    page,
    y,
    (s) => (s.freeX === null ? null : { x: s.freeX, y }),
    `some stretch of the row at y=${y} should be free of labels`,
  )
}

/** Wait for the overlay to settle; returns the airport labels it shows. */
export async function settledAirports(page: Page): Promise<OverlaySample['airports']> {
  return settled(page, null, (s) => s.airports, 'the overlay should settle')
}

/**
 * An airport label well inside the view (a `margin` px clear of the left/right edges), once the overlay
 * has settled.
 */
export async function airportLabel(page: Page, margin: number): Promise<{ ident: string; box: Box }> {
  const width = page.viewportSize()!.width
  return settled(
    page,
    null,
    (s) => s.airports.find((a) => a.box.x > margin && a.box.x + a.box.width < width - margin) ?? null,
    `an airport label should be on screen at least ${margin} px from either edge`,
  )
}

/** Drag-to-look from a free point on row `y` (see freePoint) by (dx, dy). */
export async function dragView(page: Page, y: number, dx: number, dy: number) {
  const from = await freePoint(page, y)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(Math.max(1, from.x + dx), from.y + dy, { steps: 12 })
  await page.mouse.up()
}

/** Open the AR view and turn it so the horizon (where airport labels sit) is near the middle. */
export async function openArAtHorizon(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('ar-identify-toggle')).toBeVisible({ timeout: 30_000 })
  const box = (await page.locator('body').boundingBox())!
  // The start pose looks 20° up; pull the horizon toward the middle of the view.
  await dragView(page, box.y + box.height / 2 - 60, 0, 120)
  await expect(page.getByTestId('ar-horizon')).toBeVisible()
}
