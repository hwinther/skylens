/**
 * Away-mode source credits: each aggregator the backend may serve traffic from is named and linked
 * (adsb.fi's terms require the link), and the own feed carries no credit.
 */

import { awaySourceCredit, creditText } from "@/components/awaySource";

test("every away-mode provider has a linked credit", () => {
  for (const src of ["adsblol", "airplaneslive", "adsbfi", "adsbx"]) {
    const credit = awaySourceCredit(src);
    expect(credit).not.toBeNull();
    expect(credit!.url).toMatch(/^https:\/\//);
  }
  expect(awaySourceCredit("adsbfi")!.url).toBe("https://adsb.fi");
});

test("the own feed and unknown tags get no credit", () => {
  expect(awaySourceCredit("adsb")).toBeNull();
  expect(awaySourceCredit(undefined)).toBeNull();
  expect(awaySourceCredit("whatever")).toBeNull();
});

test("credit text keeps the ODbL note for adsb.lol", () => {
  expect(creditText(awaySourceCredit("adsblol")!)).toBe("Away-mode traffic: adsb.lol (ODbL)");
  expect(creditText(awaySourceCredit("adsbfi")!)).toBe("Away-mode traffic: adsb.fi");
});
