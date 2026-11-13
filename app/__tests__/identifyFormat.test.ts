import type { IdentifyMatch, IdentifyResult, Landmark } from "@/ar/identify";
import {
  formatLandmarkDistance,
  identifyAccessibleLabel,
  identifyAlternatives,
  identifySummary,
  landmarkKindLabel,
} from "@/components/identifyFormat";

function match(landmark: Partial<Landmark> & Pick<Landmark, "kind" | "name">, distanceKm: number): IdentifyMatch {
  return {
    landmark: { id: "g1", lat: 0, lon: 0, ...landmark },
    distanceKm,
    azimuthDeg: 0,
    elevationDeg: 0,
    errorDeg: 0,
    score: 0,
  };
}

const peak = match({ kind: "peak", name: "Gaustatoppen", elevationM: 1883 }, 117.4);
const town = match({ kind: "town", name: "Drøbak" }, 12.34);

describe("identifyFormat", () => {
  it("labels kinds", () => {
    expect(landmarkKindLabel("peak")).toBe("Peak");
    expect(landmarkKindLabel("hamlet")).toBe("Hamlet");
  });

  it("formats distances by magnitude", () => {
    expect(formatLandmarkDistance(0.85)).toBe("850 m");
    expect(formatLandmarkDistance(12.34)).toBe("12.3 km");
    expect(formatLandmarkDistance(117.4)).toBe("117 km");
  });

  it("summarises kind, distance and (peaks only) height", () => {
    expect(identifySummary(peak)).toBe("Peak · 117 km · 1883 m high");
    expect(identifySummary(town)).toBe("Town · 12.3 km");
  });

  it("lists the runner-ups only when there are some", () => {
    const alone: IdentifyResult = { best: peak, alternatives: [] };
    expect(identifyAlternatives(alone)).toBeNull();
    expect(identifyAlternatives({ best: peak, alternatives: [town] })).toBe("Also that way: Drøbak");
  });

  it("spells the result out for a screen reader", () => {
    expect(identifyAccessibleLabel({ best: peak, alternatives: [] })).toBe(
      "Gaustatoppen, peak, 117 kilometres away, 1883 metres high",
    );
    expect(identifyAccessibleLabel({ best: match({ kind: "village", name: "Bø" }, 0.8), alternatives: [] })).toBe(
      "Bø, village, 800 metres away",
    );
    expect(identifyAccessibleLabel(null)).toBe("Nothing named in that direction");
  });
});
