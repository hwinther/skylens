/**
 * Hub resilience: the web app must get live data even when its first SignalR connect fails.
 *
 * Regression for "I have to sign out and back in to get live data on web". useLiveFeed only
 * rebuilds the connection when the auth status flips, and withAutomaticReconnect only covers a
 * connection that was already up. So a start() that fails once — the backend restarting, a network
 * blip, or the hub rejecting a stale token at the handshake — left the app connected to nothing
 * until a sign-out/sign-in toggled the status.
 *
 * The test fails the first WebSocket to /hubs/aircraft (the page sees it close before the SignalR
 * handshake completes) and lets later attempts through to the real backend.
 */

import { expect, type Page, test } from './fixtures'

async function statusCount(page: Page): Promise<number> {
  const text = await page.getByTestId('status-aircraft-count').textContent()
  const n = parseInt((text ?? '').trim(), 10)
  return Number.isNaN(n) ? 0 : n
}

test('live feed recovers when the first hub connect fails', async ({ page }) => {
  let attempts = 0
  await page.routeWebSocket(/\/hubs\/aircraft/, (ws) => {
    attempts++
    // First attempt: never reach the server, close as a failed upgrade would.
    if (attempts === 1) {
      void ws.close({ code: 1006, reason: 'simulated failed connect' })
      return
    }
    ws.connectToServer()
  })

  await page.goto('/')
  await expect(page.getByTestId('status-aircraft-count')).toBeVisible()

  await expect
    .poll(() => statusCount(page), {
      message: 'the app should retry the hub connect and receive a snapshot without a sign-in toggle',
      timeout: 45_000,
    })
    .toBeGreaterThan(0)
  expect(attempts, 'the first connect was failed on purpose, so a retry must have happened').toBeGreaterThan(1)
})
