/**
 * AR labels on desktop web tell a tap from a drag. Drag-to-look runs on the view under the labels, so a
 * drag can start on a label (an airport label on the horizon, a replayed aircraft); releasing it must
 * only turn the view, not open that label's detail card. A plain click on a label still opens it.
 *
 * Airport labels are the subject: they are fixed on the sky (unlike the drifting replay traffic), so
 * where one is after the overlay settles is where it stays until the next drag.
 */

import { airportLabel, dragView, openArAtHorizon, settledAirports } from './arView'
import { expect, test } from './fixtures'

/**
 * How far the pointer drags, in px: well past the tap slop (10 px) and the Pan's activation (15 px). The
 * sky moves ~3x the drag the other way at the default FOV, hence the wide margin for the label.
 */
const DRAG_PX = 60
const EDGE_MARGIN_PX = 260

test('a drag that starts on a label turns the view without opening its card; a click opens it', async ({ page }) => {
  await openArAtHorizon(page)
  // Turn from east to north (2 x 45°, 0.15°/px), toward Gardermoen and the other fields north of the
  // fixture home, so airport labels sit on the horizon in front of us.
  const body = (await page.locator('body').boundingBox())!
  const cy = body.y + body.height / 2
  await dragView(page, cy, -300, 0)
  await dragView(page, cy, -300, 0)
  await expect(page.getByTestId('compass-N')).toBeVisible()
  const card = page.getByTestId('detail-card')

  // Press on an airport label, drag sideways to turn the view, release.
  const start = await airportLabel(page, EDGE_MARGIN_PX)
  const from = { x: start.box.x + start.box.width / 2, y: start.box.y + start.box.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + DRAG_PX, from.y, { steps: 12 })
  await page.mouse.up()

  // Once the overlay has redrawn for the new pose: the view turned (the label moved)...
  const after = (await settledAirports(page)).find((a) => a.ident === start.ident)
  expect(after, `${start.ident} should still be on screen after the drag`).toBeDefined()
  expect(Math.abs(after!.box.x - start.box.x)).toBeGreaterThan(DRAG_PX)
  // ...and the release was not taken as a tap on the label.
  await expect(card).toHaveCount(0)

  // A plain click on an airport label opens its card.
  const target = await airportLabel(page, 0)
  await page.getByTestId(`ar-airport-${target.ident}`).click()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toHaveAttribute('aria-label', 'Airport details')
})
