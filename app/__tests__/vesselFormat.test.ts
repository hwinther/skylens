/**
 * Pure formatting helpers for the vessel detail sheet: the AIS nav-status lookup, overall length×beam
 * derivation, and the coarse AtoN aid-type label. These are the load-bearing bits of the sheet worth
 * pinning without rendering React.
 */

import { aidTypeLabel, formatDimensions, navStatusText } from "@/components/vesselFormat";

describe("navStatusText", () => {
  it("maps the common AIS nav-status codes to text", () => {
    expect(navStatusText(0)).toBe("Under way using engine");
    expect(navStatusText(1)).toBe("At anchor");
    expect(navStatusText(2)).toBe("Not under command");
    expect(navStatusText(5)).toBe("Moored");
    expect(navStatusText(7)).toBe("Engaged in fishing");
    expect(navStatusText(8)).toBe("Under way sailing");
  });

  it("falls back to the raw number for an unmapped code", () => {
    expect(navStatusText(13)).toBe("13");
    expect(navStatusText(99)).toBe("99");
  });

  it("returns null for a missing status (so the caller hides the row)", () => {
    expect(navStatusText(null)).toBeNull();
    expect(navStatusText(undefined)).toBeNull();
  });
});

describe("formatDimensions", () => {
  it("sums bow+stern for length and port+starboard for beam", () => {
    expect(formatDimensions({ dimBow: 100, dimStern: 50, dimPort: 10, dimStarboard: 12 })).toBe(
      "150 × 22 m",
    );
  });

  it("degrades to a single figure when only one axis is reported", () => {
    expect(formatDimensions({ dimBow: 30, dimStern: 20 })).toBe("50 m");
    expect(formatDimensions({ dimPort: 5, dimStarboard: 6 })).toBe("11 m beam");
  });

  it("returns null when no dimensions are present", () => {
    expect(formatDimensions({})).toBeNull();
    expect(formatDimensions({ dimBow: 0, dimStern: 0, dimPort: 0, dimStarboard: 0 })).toBeNull();
    expect(formatDimensions({ dimBow: null, dimStarboard: undefined })).toBeNull();
  });
});

describe("aidTypeLabel", () => {
  it("buckets aid-type codes into coarse marine labels", () => {
    expect(aidTypeLabel(5)).toBe("Light");
    expect(aidTypeLabel(15)).toBe("Beacon");
    expect(aidTypeLabel(25)).toBe("Buoy");
  });

  it("falls back to a generic label for unknown/absent codes", () => {
    expect(aidTypeLabel(0)).toBe("Aid to navigation");
    expect(aidTypeLabel(null)).toBe("Aid to navigation");
    expect(aidTypeLabel(undefined)).toBe("Aid to navigation");
  });
});
