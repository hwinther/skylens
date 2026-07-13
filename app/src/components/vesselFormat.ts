/**
 * Pure formatting helpers for the vessel detail sheet — kept out of the component so the AIS lookups
 * (nav-status text, overall dimensions, AtoN aid-type label) are unit-testable without React.
 */

/**
 * AIS navigation-status code → human text (ITU-R M.1371, message 1/2/3). Only Class-A vessels report
 * it. Codes outside the table (and the "not defined" 15) fall back to the raw number so nothing is
 * silently dropped. null/undefined input → null (row hidden by the caller).
 */
const NAV_STATUS: Record<number, string> = {
  0: "Under way using engine",
  1: "At anchor",
  2: "Not under command",
  3: "Restricted manoeuvrability",
  4: "Constrained by draught",
  5: "Moored",
  6: "Aground",
  7: "Engaged in fishing",
  8: "Under way sailing",
  9: "Reserved (HSC)",
  10: "Reserved (WIG)",
  11: "Towing astern",
  12: "Pushing ahead / towing alongside",
  14: "AIS-SART / MOB / EPIRB",
};

export function navStatusText(code: number | null | undefined): string | null {
  if (code == null) return null;
  return NAV_STATUS[code] ?? String(code);
}

/** The four AIS reference-point distances (metres) needed to derive a vessel's overall size. */
export interface VesselDimensions {
  dimBow?: number | null;
  dimStern?: number | null;
  dimPort?: number | null;
  dimStarboard?: number | null;
}

/**
 * Overall length × beam (metres) from the four AIS antenna-offset dimensions: length = bow + stern,
 * beam = port + starboard. Returns null when neither is available, and degrades to a single figure
 * when only one axis is reported.
 */
export function formatDimensions(dims: VesselDimensions): string | null {
  const length = (dims.dimBow ?? 0) + (dims.dimStern ?? 0);
  const beam = (dims.dimPort ?? 0) + (dims.dimStarboard ?? 0);
  if (length <= 0 && beam <= 0) return null;
  if (beam <= 0) return `${length} m`;
  if (length <= 0) return `${beam} m beam`;
  return `${length} × ${beam} m`;
}

/**
 * Coarse label for an AtoN aid-type code (ITU-R M.1371, message 21) — enough to name the mark in the
 * detail sheet without the full 32-entry table. Aligned with the buckets iconForVessel draws.
 */
export function aidTypeLabel(aidType: number | null | undefined): string {
  const t = aidType ?? 0;
  if (t >= 1 && t <= 8) return "Light";
  if (t >= 9 && t <= 19) return "Beacon";
  if (t >= 20 && t <= 31) return "Buoy";
  return "Aid to navigation";
}
