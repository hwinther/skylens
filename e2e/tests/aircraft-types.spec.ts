/**
 * Readable aircraft types: the hub DTO's `t` (ICAO type designator, set by the backend from the offline
 * aircraft DB or the aggregator) is looked up in the app's bundled type table (src/aircraft) for a
 * readable name, the class in words and the aeroplane-vs-helicopter icon. The source-mode backend has no
 * aircraft DB, so the test proxies the SignalR hub and sets `t` on two replayed aircraft in every
 * "snapshot" frame (as military.spec.ts does for `mil`); the detail lookup is answered with the
 * designator only, so a live OpenSky answer can't change the expected text. Everything after that
 * (store, List, card, lookup) runs for real. Backend side (registry → `t`) is covered by unit tests.
 */

import { expect, type Page, test } from './fixtures'

/** Positioned aircraft in backend/tests/Api.Tests/fixtures/aircraft.json: an A3 airliner and an A7 rotorcraft. */
const PLANE_HEX = '4aca79'
const HELI_HEX = '478df1'
const TYPES: Record<string, string> = { [PLANE_HEX]: 'B738', [HELI_HEX]: 'EC35' }

/** SignalR's JSON protocol ends every message with the ASCII record separator. */
const RS = String.fromCharCode(0x1e)

async function setTypeDesignators(page: Page) {
  await page.routeWebSocket(/\/hubs\/aircraft/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== 'string') {
        ws.send(message)
        return
      }
      const frames = message.split(RS).map((frame) => {
        if (!frame.includes('"snapshot"')) return frame
        const msg = JSON.parse(frame) as { target?: string; arguments?: [{ hex: string; t?: string }[]] }
        if (msg.target !== 'snapshot' || !msg.arguments) return frame
        for (const ac of msg.arguments[0]) if (TYPES[ac.hex]) ac.t = TYPES[ac.hex]
        return JSON.stringify(msg)
      })
      ws.send(frames.join(RS))
    })
  })
  // The card's detail lookup: the designator only (no per-airframe name), never a live upstream answer.
  // Fetched for real first, so the backend's CORS + X-Skylens-Api headers stay; only the body changes.
  await page.route(/\/api\/aircraft\/[0-9a-f]{6}$/, async (route) => {
    const hex = route.request().url().slice(-6)
    const response = await route.fetch()
    await route.fulfill({
      response,
      status: 200,
      json: { state: null, metadata: { hex, typeCode: TYPES[hex] ?? null, source: 'db' } },
    })
  })
}

test('list: a known designator reads as a type name next to the code, with the type-data credit', async ({ page }) => {
  await setTypeDesignators(page)
  await page.goto('/list')

  await expect(page.getByTestId(`list-typeline-${PLANE_HEX}`)).toHaveText('Boeing 737-800 · B738', { timeout: 30_000 })
  await expect(page.getByTestId(`list-typeline-${HELI_HEX}`)).toHaveText('Airbus Helicopters EC-135/635 · EC35')
  await expect(page.getByTestId('list-type-credit')).toContainText('Mictronics aircraft database (ODC-By)')
})

test.describe('phone card', () => {
  test.use({ viewport: { width: 412, height: 915 } })

  test('collapsed shows the short name, expanded the class in words', async ({ page }) => {
    await setTypeDesignators(page)
    await page.goto('/list')
    await page.getByTestId(`list-ac-${HELI_HEX}`).click({ timeout: 30_000 })

    await expect(page.getByTestId('detail-card-summary')).toContainText('Airbus EC-135/635', { timeout: 15_000 })
    await page.getByTestId('detail-card-toggle').click()
    await expect(page.getByTestId('detail-type')).toHaveText('Airbus Helicopters EC-135/635 (EC35)')
    await expect(page.getByTestId('detail-type-class')).toHaveText('Helicopter · 2 turbine engines · Light wake')
    await expect(page.getByTestId('detail-type-credit')).toBeVisible()
  })
})
