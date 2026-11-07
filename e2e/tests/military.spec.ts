/**
 * Military highlighting: an aircraft whose snapshot carries `mil: true` (the backend sets it from the
 * tar1090-db / readsb dbFlags military bit) gets a MIL badge in the List and an orange marker on the
 * Map. The replay fixture has no military airframes, so the test proxies the SignalR hub and flags one
 * known aircraft in every "snapshot" frame on its way to the browser — everything after the hub (store,
 * list, map rendering) runs for real. The backend side (registry flag → DTO) is covered by unit tests.
 */

import { expect, type Page, test } from './fixtures'

/** A positioned aircraft in backend/tests/Api.Tests/fixtures/aircraft.json. */
const MIL_HEX = '4aca79'

/** SignalR's JSON protocol ends every message with the ASCII record separator. */
const RS = String.fromCharCode(0x1e)

async function flagOneAircraftMilitary(page: Page) {
  await page.routeWebSocket(/\/hubs\/aircraft/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== 'string') {
        ws.send(message)
        return
      }
      const frames = message.split(RS).map((frame) => {
        if (!frame.includes('"snapshot"')) return frame
        const msg = JSON.parse(frame) as { target?: string; arguments?: [{ hex: string; mil?: boolean }[]] }
        if (msg.target !== 'snapshot' || !msg.arguments) return frame
        for (const ac of msg.arguments[0]) if (ac.hex === MIL_HEX) ac.mil = true
        return JSON.stringify(msg)
      })
      ws.send(frames.join(RS))
    })
  })
}

test('list: a military aircraft carries the MIL badge', async ({ page }) => {
  await flagOneAircraftMilitary(page)
  await page.goto('/list')

  await expect(page.getByTestId(`list-ac-${MIL_HEX}`)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(`list-mil-${MIL_HEX}`)).toHaveText('MIL')
  // Only the flagged one: civil aircraft carry no badge.
  await expect(page.locator('[data-testid^="list-mil-"]')).toHaveCount(1)
})

test('map: a military aircraft is drawn in the military colour', async ({ page }) => {
  await flagOneAircraftMilitary(page)
  await page.goto('/map')
  await page.getByTestId('map-view-map').click()

  const marker = page.getByTestId(`map-mil-${MIL_HEX}`)
  await expect(marker).toBeAttached({ timeout: 30_000 })
  await expect(marker).toHaveCSS('color', 'rgb(242, 153, 91)') // color.military #F2995B
})
