/**
 * Wording for the AR identify result: kind labels, distance / height formatting, and the accessible
 * label a screen reader announces. Pure TS (no React), so the logic jest project covers it.
 */

import type { IdentifyMatch, IdentifyResult, LandmarkKind } from "@/ar/identify";

const KIND_LABEL: Record<LandmarkKind, string> = {
  peak: "Peak",
  city: "City",
  town: "Town",
  village: "Village",
  hamlet: "Hamlet",
};

export function landmarkKindLabel(kind: LandmarkKind): string {
  return KIND_LABEL[kind] ?? "Place";
}

/** "850 m" under 1 km, "12.3 km" under 20 km, "117 km" beyond. */
export function formatLandmarkDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 20) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** The summary line under the name: kind · distance · height (peaks only). */
export function identifySummary(match: IdentifyMatch): string {
  const parts = [landmarkKindLabel(match.landmark.kind), formatLandmarkDistance(match.distanceKm)];
  if (match.landmark.kind === "peak" && match.landmark.elevationM != null) {
    parts.push(`${match.landmark.elevationM} m high`);
  }
  return parts.join(" · ");
}

/** "Also that way: A, B" — or null when the best match stands alone. */
export function identifyAlternatives(result: IdentifyResult): string | null {
  if (result.alternatives.length === 0) return null;
  return `Also that way: ${result.alternatives.map((a) => a.landmark.name).join(", ")}`;
}

/** Distance spelled out for a screen reader ("12.3 kilometres", "850 metres"). */
function spokenDistance(km: number): string {
  const short = formatLandmarkDistance(km);
  return short.endsWith(" km") ? short.replace(/ km$/, " kilometres") : short.replace(/ m$/, " metres");
}

/** What a screen reader announces for a result (or for an empty direction). */
export function identifyAccessibleLabel(result: IdentifyResult | null): string {
  if (!result) return "Nothing named in that direction";
  const { landmark, distanceKm } = result.best;
  const kind = landmarkKindLabel(landmark.kind).toLowerCase();
  const height =
    landmark.kind === "peak" && landmark.elevationM != null ? `, ${landmark.elevationM} metres high` : "";
  return `${landmark.name}, ${kind}, ${spokenDistance(distanceKm)} away${height}`;
}
