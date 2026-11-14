/**
 * Sign-in flow on web when the backend requires a sign-in.
 *
 * The e2e backend runs with DevAuth, so every request is already authenticated. To simulate real
 * auth, an anonymous GET /api/me (the app's "does this server need a sign-in?" probe) is answered
 * with 401; requests that carry a bearer go through to the DevAuth backend untouched. The identity
 * provider (auth.wsh.no) is stubbed: discovery, an authorization endpoint that redirects the popup
 * straight back to the app's /oauth page with a code, and a token endpoint.
 *
 * @local-only: a deployed env (BASE_URL) has the real IdP and starts every spec signed in through
 * auth.setup.ts, which is that env's sign-in test.
 */

import type { BrowserContext, Route } from '@playwright/test'
import { expect, type Page, test } from './fixtures'

const ISSUER = 'https://auth.wsh.no'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

async function statusCount(page: Page): Promise<number> {
  const text = await page.getByTestId('status-aircraft-count').textContent()
  const n = parseInt((text ?? '').trim(), 10)
  return Number.isNaN(n) ? 0 : n
}

/** The backend demands a sign-in: an anonymous GET /api/me is a 401 from the API itself. */
async function requireSignIn(page: Page) {
  await page.route('**/api/me', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET' || request.headers()['authorization']) {
      await route.continue()
      return
    }
    // Keep the backend's own headers (X-Skylens-Api, CORS in source mode); only swap the status.
    const response = await route.fetch()
    await route.fulfill({ response, status: 401, body: '{}' })
  })
}

interface IdpStub {
  tokenRequests: number
  /** What the token endpoint answers; flip to 'ok' to let a retry succeed. */
  tokenAnswer: 'ok' | 'error'
}

/** Stub the OIDC provider for the whole context (the sign-in popup is a separate page). */
async function stubIdp(context: BrowserContext): Promise<IdpStub> {
  const stub: IdpStub = { tokenRequests: 0, tokenAnswer: 'ok' }
  await context.route(`${ISSUER}/**`, async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/api/oidc/authorization`,
          token_endpoint: `${ISSUER}/api/oidc/token`,
          userinfo_endpoint: `${ISSUER}/api/oidc/userinfo`,
          jwks_uri: `${ISSUER}/jwks.json`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        }),
      })
      return
    }
    if (url.pathname === '/api/oidc/authorization') {
      // "The user signed in": send the popup back to the app's redirect URI with a code and the state.
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      redirect.searchParams.set('code', 'e2e-code')
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
      await route.fulfill({ status: 302, headers: { location: redirect.toString() } })
      return
    }
    if (url.pathname === '/api/oidc/token') {
      stub.tokenRequests++
      if (stub.tokenAnswer === 'error') {
        await route.fulfill({
          status: 400,
          headers: CORS,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid_grant', error_description: 'e2e: code rejected' }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'e2e-access-token',
          refresh_token: 'e2e-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })
      return
    }
    await route.fulfill({ status: 404, headers: CORS, body: '' })
  })
  return stub
}

/** Count every attempt to reach the hub: SignalR's negotiate POST and the WebSocket itself. */
function watchHub(page: Page): { attempts: string[] } {
  const seen = { attempts: [] as string[] }
  page.on('websocket', (ws) => {
    if (ws.url().includes('/hubs/aircraft')) seen.attempts.push(ws.url())
  })
  page.on('request', (req) => {
    if (req.url().includes('/hubs/aircraft')) seen.attempts.push(req.url())
  })
  return seen
}

let idp: IdpStub

test.beforeEach(async ({ page, context }) => {
  idp = await stubIdp(context)
  await requireSignIn(page)
})

test(
  'live and signed out: the sign-in card shows and nothing calls the API',
  { tag: '@local-only' },
  async ({ page }) => {
    const hub = watchHub(page)
    await page.goto('/')

    await expect(page.getByTestId('signin-prompt')).toBeVisible()
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('signin-prompt.png') })

    // The card floats over every tab. Opening the map (which loads airports, ports and fishing layers
    // when it may) also gives a would-be hub connect plenty of time to have shown up.
    await page.goto('/map')
    await page.getByTestId('map-view-map').click()
    await expect(page.getByTestId('signin-prompt')).toBeVisible()
    await expect(page.getByTestId('map-aircraft-count')).toBeVisible()

    expect(hub.attempts, 'no hub connection while signed out').toEqual([])
    await expect(page.getByTestId('api-issue-banner')).toHaveCount(0)
  },
)

test('"Continue in demo" hides the card and replays the demo feed', { tag: '@local-only' }, async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('signin-prompt-demo').click()

  await expect(page.getByTestId('signin-prompt')).toBeHidden()
  await expect(page.getByText('DEMO', { exact: true })).toBeVisible()
  await expect.poll(() => statusCount(page), { timeout: 15_000 }).toBeGreaterThan(0)
  // Demo makes no API calls without a session, so nothing can fail with a 401.
  await expect(page.getByTestId('api-issue-banner')).toHaveCount(0)
})

test(
  'signing in through the popup brings live data, and survives a reload',
  { tag: '@local-only' },
  async ({ page }) => {
    await page.goto('/')
    const signIn = page.getByTestId('signin-prompt-signin')
    await expect(signIn).toBeEnabled()
    await signIn.click()

    await expect(page.getByTestId('signin-prompt')).toBeHidden({ timeout: 30_000 })
    expect(idp.tokenRequests).toBe(1)
    await expect
      .poll(() => statusCount(page), {
        message: 'aircraft should stream once signed in',
        timeout: 30_000,
      })
      .toBeGreaterThan(0)

    // The session is in localStorage now, so a reload stays signed in.
    await page.reload()
    await expect.poll(() => statusCount(page), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect(page.getByTestId('signin-prompt')).toHaveCount(0)
  },
)

test(
  'a rejected code exchange shows the error and the button works again',
  { tag: '@local-only' },
  async ({ page }) => {
    idp.tokenAnswer = 'error'
    await page.goto('/')
    const signIn = page.getByTestId('signin-prompt-signin')
    await expect(signIn).toBeEnabled()
    await signIn.click()

    await expect(page.getByTestId('signin-prompt-error')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('signin-prompt-error')).toContainText('Sign-in failed')
    await expect(signIn).toBeEnabled()

    // A second attempt goes through once the IdP accepts the code.
    idp.tokenAnswer = 'ok'
    await signIn.click()
    await expect(page.getByTestId('signin-prompt')).toBeHidden({ timeout: 30_000 })
    expect(idp.tokenRequests).toBe(2)
  },
)
