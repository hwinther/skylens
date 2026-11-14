/**
 * Credits for the cockpit view's 3D models (public/models/sim/, see ./models.ts), shown in Settings →
 * About → "3D models". The committed provenance file next to the models
 * (public/models/sim/ATTRIBUTION.md) carries the same list with what was changed; a jest test keeps the
 * two and the files in step.
 *
 * CC BY 3.0 asks for title, author, licence (with a link), source (with a link) and a note that the work
 * was modified; Poly Pizza's suggested form is "<Title> by <Creator> [CC-BY] (licence URL) via Poly Pizza
 * (model URL)". The two turboprops are CC0 (no credit needed); the author is named as a courtesy.
 */

import type { SimModelClass } from "./models";

export const CC_BY_3_URL = "https://creativecommons.org/licenses/by/3.0/";
export const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";

export interface ModelCredit {
  cls: SimModelClass;
  /** What the model stands for in the app ("Narrow-body jet"). */
  role: string;
  title: string;
  author: string;
  licence: "CC BY 3.0" | "CC0";
  licenceUrl: string;
  /** The model's page. */
  sourceUrl: string;
  /** Where it was found ("Poly Pizza", "OpenGameArt"). */
  via: string;
}

const polyPizza = (id: string) => `https://poly.pizza/m/${id}`;

export const MODEL_CREDITS: readonly ModelCredit[] = [
  { cls: "airliner", role: "Narrow-body jet", title: "Airplane", author: "jeremy", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("9Ev6pklkSYp"), via: "Poly Pizza" },
  { cls: "widebody", role: "Wide-body jet", title: "Boeing 747", author: "Miha Lunar", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("49CLof4tP2V"), via: "Poly Pizza" },
  { cls: "turboprop", role: "Turboprop", title: "Twin turboprop rigged airplane. Low poly.", author: "mfonasd", licence: "CC0", licenceUrl: CC0_URL, sourceUrl: "https://opengameart.org/content/twin-turboprop-rigged-airplane-low-poly", via: "OpenGameArt" },
  { cls: "twin-prop", role: "Small twin prop", title: "Low poly twin prop airplane", author: "mfonasd", licence: "CC0", licenceUrl: CC0_URL, sourceUrl: "https://opengameart.org/content/low-poly-twin-prop-airplane", via: "OpenGameArt" },
  { cls: "light-single", role: "Light aircraft", title: "Small Airplane", author: "Vojtěch Balák", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("7cvx6ex-xfL"), via: "Poly Pizza" },
  { cls: "bizjet", role: "Business jet", title: "Jet", author: "Poly by Google", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("bgUY8zN2Bq9"), via: "Poly Pizza" },
  { cls: "helicopter", role: "Helicopter", title: "Helicopter", author: "jeremy", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("eb7b31pjGtQ"), via: "Poly Pizza" },
  { cls: "cargo-ship", role: "Cargo ship", title: "Container Ship", author: "Alex Safayan", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("3AmDGcCu6Ll"), via: "Poly Pizza" },
  { cls: "ferry", role: "Ferry / passenger ship", title: "Cruise liner", author: "jeremy", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("aOikPp4rz68"), via: "Poly Pizza" },
  { cls: "small-boat", role: "Small boat", title: "Boat", author: "Poly by Google", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("8vekojz4Abf"), via: "Poly Pizza" },
  { cls: "satellite", role: "Satellite", title: "Satellite", author: "Poly by Google", licence: "CC BY 3.0", licenceUrl: CC_BY_3_URL, sourceUrl: polyPizza("fmYHY1leH_P"), via: "Poly Pizza" },
];

/** What was done to every model (CC BY's "indicate if changes were made"). */
export const MODEL_CHANGES_NOTE = "Modified: reoriented, rescaled, recentred and compressed for the app.";

/** One credit line, Poly Pizza's form for CC BY ("Airplane by jeremy [CC-BY] (…) via Poly Pizza (…)"). */
export function modelCreditLine(c: ModelCredit): string {
  const tag = c.licence === "CC0" ? "CC0" : "CC-BY";
  return `${c.title} by ${c.author} [${tag}] (${c.licenceUrl}) via ${c.via} (${c.sourceUrl})`;
}

/** The collapsed row's summary: "11 models · CC BY 3.0 / CC0". */
export function modelCreditsSummary(credits: readonly ModelCredit[] = MODEL_CREDITS): string {
  const licences = [...new Set(credits.map((c) => c.licence))].join(" / ");
  return `${credits.length} models · ${licences}`;
}
