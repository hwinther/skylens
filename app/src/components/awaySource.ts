/**
 * Credits for away-mode aircraft (traffic outside the own feed, fetched by the backend from free or paid
 * aggregators and tagged in `src`). adsb.lol is ODbL; adsb.fi's terms require citing it with a link to
 * its home page; airplanes.live and ADS-B Exchange are credited the same way for consistency. Pure (no
 * RN imports), so it is unit-testable.
 */

export interface SourceCredit {
  /** Human name, also used for the detail sheet's Source row. */
  name: string;
  /** Licence / note shown after the name, if any. */
  note?: string;
  /** Home page the credit links to. */
  url: string;
}

const CREDITS: Record<string, SourceCredit> = {
  adsblol: { name: "adsb.lol", note: "ODbL", url: "https://adsb.lol" },
  airplaneslive: { name: "airplanes.live", url: "https://airplanes.live" },
  adsbfi: { name: "adsb.fi", url: "https://adsb.fi" },
  adsbx: { name: "ADS-B Exchange", url: "https://www.adsbexchange.com" },
};

/** Credit for an away-mode `src` tag; null for the own feed ("adsb") and unknown tags. */
export function awaySourceCredit(src: string | null | undefined): SourceCredit | null {
  return (src && CREDITS[src]) || null;
}

/** "Away-mode traffic: adsb.lol (ODbL)". */
export function creditText(credit: SourceCredit): string {
  return `Away-mode traffic: ${credit.name}${credit.note ? ` (${credit.note})` : ""}`;
}
