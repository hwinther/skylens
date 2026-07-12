/**
 * Live integration (orbital): the web frontend must render satellites propagated from the backend's
 * TLE snapshot — the space counterpart to vessels.spec.ts's AIS coverage and live.spec.ts's aircraft.
 *
 * The API container serves satellites from the Development-gated fixtures baked into the image
 * (Satellites__TleFile + Satellites__TransmittersFile → /app/fixtures/tle.json + transmitters.json).
 * The app's useSatellites hook fetches GET /api/satellites, builds SGP4 satrecs, and re-propagates the
 * look angles at 1 Hz; a `list-sat-*` row proves the whole chain — fixture load, /api/satellites, satrec
 * build, propagate, elevation-mask select, render — worked end to end.
 *
 * DETERMINISM: the fixture carries ~10 GNSS satellites (GPS/Galileo/GLONASS/BeiDou), all in ~20 000 km
 * MEO orbits. From any point on Earth at any wall-clock time several sit above the 5° elevation mask,
 * and MEO TLEs stay propagation-valid for months, so "at least one satellite is overhead" can never
 * flake. We therefore assert only on whatever `list-sat-*` rows exist — NEVER on the ISS (25544), whose
 * LEO pass may or may not be above the mask at test time. The Playwright geolocation (compose FEED
 * origin 59.9,11.1, granted in playwright.ci.config.ts) is the observer the hook propagates against.
 *
 * NOTE (no AR-page test): the third, optional "AR overlay shows a sat-label-*" assertion is omitted.
 * vessels.spec.ts deliberately stays off the AR view, and even live.spec.ts only reaches an aircraft
 * label by drag-sweeping the heading across the horizon where planes sit. Satellites project at high
 * elevation (GNSS cluster near the zenith), so surfacing a `sat-label-*` would mean inventing an
 * elevation-drag search the suite doesn't otherwise use, on the one view whose pose is synthetic on
 * web. The /list overhead section renders the exact same useSatellites output through the same
 * fetch → satrec → propagate → select chain, so the list assertions below cover the pipeline without
 * that fragility. The AR-side SatelliteLabel rendering is already covered by the app-side jest tests.
 */

import { test, expect } from "@playwright/test";

test("overhead list shows satellites from fixture TLEs", async ({ page }) => {
  await page.goto("/list");

  // The Overhead header renders once the showSatellites toggle is on (default) and the section mounts;
  // the count itself needs the /api/satellites fetch plus the first 1 Hz propagate tick to populate,
  // so allow a generous window for the MEO satellites to be selected above the mask.
  const count = page.getByTestId("list-sat-count");
  await expect(count).toBeVisible();

  // Match ONLY the numeric row testIDs (list-sat-<noradId>) — a bare `^="list-sat-"` prefix also
  // matches the `list-sat-count` header, which renders immediately with "Overhead (0)" and would let
  // the test race ahead of the first propagate tick. Waiting on a numeric row waits for real data.
  const satRow = page.getByTestId(/^list-sat-\d+$/).first();
  await expect(satRow).toBeVisible({ timeout: 30_000 });

  // "Overhead (N)" with N >= 1 — the MEO GNSS constellations guarantee at least one is always up.
  const countText = ((await count.textContent()) ?? "").trim();
  const m = countText.match(/Overhead \((\d+)\)/);
  expect(m, 'header reads "Overhead (N)"').not.toBeNull();
  expect(Number(m![1]), "at least one satellite is overhead").toBeGreaterThanOrEqual(1);

  // The row is keyed by a real NORAD catalogue id — proves it's a satellite row, not a stray match.
  const testId = (await satRow.getAttribute("data-testid")) ?? "";
  const noradId = testId.replace("list-sat-", "");
  expect(Number(noradId), "sat rows are keyed list-sat-<noradId>").toBeGreaterThan(0);

  // The row shows a "<elevation>° <DIR>" cell (compass8 direction after the degree elevation). A bare
  // degree sign is the elevation readout — the range cell uses "km", so "°" is unambiguously elevation.
  const rowText = ((await satRow.textContent()) ?? "").trim();
  expect(rowText, "sat row shows a degree elevation").toMatch(/\d+\s*°/);
});

test("satellite detail sheet shows transmitters", async ({ page }) => {
  await page.goto("/list");

  // Tap the FIRST overhead row, whatever it is (highest-elevation satellite — may be a GNSS member with
  // no transmitters, or the ISS/an amateur sat with many). The sheet must open either way. The numeric-
  // only regex testID skips the `list-sat-count` header (a plain Text with no press handler).
  const firstRow = page.getByTestId(/^list-sat-\d+$/).first();
  await expect(firstRow).toBeVisible({ timeout: 30_000 });
  await firstRow.click();

  // GET /api/satellites/{noradId} drives the sheet; the title renders once that fetch resolves.
  await expect(page.getByTestId("sat-detail-title")).toBeVisible({ timeout: 15_000 });

  // Robust to which satellite is up: a sat WITH transmitters shows sat-tx-0; one WITHOUT (e.g. a GNSS
  // member — the endpoint returns 200 with an empty list) shows the sat-detail-empty placeholder. Either
  // proves the transmitter fetch + render path ran; a stuck spinner / error would show neither.
  const tx0 = page.getByTestId("sat-tx-0");
  const empty = page.getByTestId("sat-detail-empty");
  await expect(tx0.or(empty)).toBeVisible({ timeout: 15_000 });
});
