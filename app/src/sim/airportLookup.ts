/**
 * Resolves a known route's destination airport code to a place when it is not among the nearby
 * airports the globe already fetched: one GET /api/airports/{ident} per code (an OFFLINE database read
 * on the backend, no upstream spend), remembered for as long as the resolver lives (the cockpit view's
 * session), success or failure alike. So there is never a refetch loop: an unknown code (404) or a
 * failed request simply means no route line for that code. Pure TS (the fetch is injected), jest-tested.
 *
 * It never decides that a route is known: the caller only asks for a code the detail card already
 * handed over under the gated policy (its free cached read, or the user's own "Route" tap).
 */

import type { AirportDto } from "@/api/types";
import type { OverlayPlace } from "./overlay";
import { airportLookupCode, airportPlace } from "./route";

export interface AirportLookupDeps {
  /** The airport, or null when unknown (404); a rejection is a failure. */
  fetchAirport: (ident: string) => Promise<AirportDto | null>;
  /** The API gate (isApiAllowed): nothing is fetched, or remembered, while it is closed. */
  allowed: () => boolean;
}

/** A code's state: resolved to a place, known to have none (null), or still being fetched. */
export type AirportLookupState = OverlayPlace | null | "pending";

export class AirportLookup {
  private readonly known = new Map<string, AirportLookupState>();

  constructor(private readonly deps: AirportLookupDeps) {}

  /**
   * The place for `code` if it has been resolved; otherwise starts its one fetch (when the gate is open)
   * and returns "pending", or null for a code that cannot be resolved (malformed, or already failed).
   * Returns undefined while the gate is closed and the code has never been asked for.
   */
  resolve(code: string | null | undefined): AirportLookupState | undefined {
    const ident = airportLookupCode(code);
    if (!ident) return null;
    const state = this.known.get(ident);
    if (state !== undefined) return state;
    if (!this.deps.allowed()) return undefined;

    this.known.set(ident, "pending");
    let request: Promise<AirportDto | null>;
    try {
      request = this.deps.fetchAirport(ident);
    } catch {
      this.known.set(ident, null);
      return null;
    }
    request.then(
      (airport) => this.known.set(ident, airport ? airportPlace(airport) : null),
      () => this.known.set(ident, null),
    );
    return "pending";
  }
}
