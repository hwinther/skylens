/**
 * The ports layer's shared labels: unnamed places fall back to their kind, the subtitle names the
 * source (OpenStreetMap vs World Port Index, which the id prefix tells apart), and commercial ports
 * draw a little larger than the many small quays and marinas.
 */

import type { PortDto } from "@/api/types";
import { PORT_GLYPH, portGlyphSize, portSubtitle, portTitle } from "@/components/webmap/portStyle";

const port = (over: Partial<PortDto> = {}): PortDto => ({
  id: "n1",
  kind: "ferry",
  name: "Oslo Vippetangen",
  lat: 59.9,
  lon: 10.7,
  ...over,
});

test("the title is the name, or the kind when unnamed", () => {
  expect(portTitle(port())).toBe("Oslo Vippetangen");
  expect(portTitle(port({ name: null, kind: "marina" }))).toBe("Marina");
  expect(portTitle(port({ name: "  ", kind: "ferry" }))).toBe("Ferry quay");
});

test("the subtitle names the kind and the source", () => {
  expect(portSubtitle(port())).toBe("Ferry quay · OpenStreetMap");
  expect(portSubtitle(port({ id: "wpi21840", kind: "harbour" }))).toBe("Harbour · World Port Index");
});

test("each kind has a glyph, and ports draw larger", () => {
  expect(Object.keys(PORT_GLYPH).sort()).toEqual(["ferry", "harbour", "marina", "port"]);
  expect(portGlyphSize("port")).toBeGreaterThan(portGlyphSize("marina"));
});
