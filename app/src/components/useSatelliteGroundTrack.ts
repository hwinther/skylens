/**
 * Ground-track data source for the Map screens (native + web). Reads the ephemeral selection from
 * satelliteTrackStore; when a satellite is selected it fetches that satellite's OMM (the same
 * GET /api/satellites/{noradId} the detail sheet uses, cancellable), builds an SGP4 satrec once, and
 * recomputes the sub-satellite path (±one orbit, antimeridian-split) plus the current sub-point.
 *
 * The track ages as the satellite moves, so it is recomputed on a slow interval (see RECOMPUTE_MS) while
 * a track is shown — slow because a ground track is context, not a live blip, and each recompute is a
 * few hundred SGP4 evaluations. Everything fails soft: an unconfigured / 401 / errored fetch simply
 * yields no track (empty segments, null sub-point) with no error surfaced — the Map just shows nothing.
 *
 * All heavy math lives in the pure src/ar/satellites module; this hook is only the fetch + interval glue,
 * so both MapScreen.tsx (react-native-maps) and MapScreen.web.tsx (Leaflet) share one implementation.
 */

import { useCallback, useEffect, useState } from "react";
import type { SatRec } from "satellite.js";
import type { ApiClient } from "@/api/client";
import { buildSatrec, groundTrack, subSatellitePoint, type GroundTrackPoint } from "@/ar";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";

/** How often the track + sub-point are recomputed while a track is shown (the sat keeps moving). */
export const RECOMPUTE_MS = 45_000;

export interface GroundTrackData {
  /** The selected NORAD id, or null when nothing is tracked (mirrors the store). */
  trackedNoradId: number | null;
  /** Display name of the tracked satellite once its detail has loaded, else null. */
  name: string | null;
  /** Sub-satellite path as antimeridian-split segments (empty until loaded / when nothing tracked). */
  segments: GroundTrackPoint[][];
  /** Current sub-satellite point, or null until loaded / when nothing tracked. */
  subPoint: GroundTrackPoint | null;
  /** Clear the current track (also used by the map's clear chip and sub-point marker). */
  clear: () => void;
}

const EMPTY_SEGMENTS: GroundTrackPoint[][] = [];

interface FetchedTrack {
  id: number;
  satrec: SatRec | null;
  name: string | null;
}

interface Computed {
  segments: GroundTrackPoint[][];
  subPoint: GroundTrackPoint | null;
}

const EMPTY_COMPUTED: Computed = { segments: EMPTY_SEGMENTS, subPoint: null };

export function useSatelliteGroundTrack(client: ApiClient): GroundTrackData {
  const trackedNoradId = useSatelliteTrackStore((s) => s.trackedNoradId);
  const setTracked = useSatelliteTrackStore((s) => s.setTracked);

  // The satrec + name for the LAST satellite whose detail we fetched. We keep the id alongside so a
  // stale in-flight/previous result never renders for a newly-selected satellite (see `satrec` below).
  const [fetched, setFetched] = useState<FetchedTrack | null>(null);
  const [computed, setComputed] = useState<Computed>(EMPTY_COMPUTED);

  // Fetch the selected satellite's OMM and build its satrec. No synchronous setState in the effect body
  // (all updates land in the async .then) so nothing is reset mid-render; a mismatched-id result is
  // filtered out below instead of being cleared here. Fails soft: a rejected fetch leaves no track.
  useEffect(() => {
    if (trackedNoradId == null) return;
    let cancelled = false;
    client
      .satelliteDetail(trackedNoradId)
      .then((detail) => {
        if (cancelled) return;
        setFetched({
          id: trackedNoradId,
          satrec: buildSatrec(detail.satellite.omm),
          name: detail.satellite.name?.trim() || null,
        });
      })
      .catch(() => {
        // Unconfigured / 401 signed-out / errored → no track, no error UI.
      });
    return () => {
      cancelled = true;
    };
  }, [trackedNoradId, client]);

  // Only trust the fetched result when it matches the current selection — while switching satellites (or
  // after clearing) the previous satrec must not linger on the map.
  const active =
    trackedNoradId != null && fetched?.id === trackedNoradId ? fetched : null;
  const satrec = active?.satrec ?? null;

  // Recompute the path + sub-point immediately, then on a slow interval so the track ages with the
  // satellite. setComputed only fires inside `recompute` / the interval callback (never synchronously in
  // the effect body), keeping this clear of the set-state-in-effect rule.
  useEffect(() => {
    if (!satrec) return;
    const recompute = () => {
      const now = new Date();
      setComputed({ segments: groundTrack(satrec, now), subPoint: subSatellitePoint(satrec, now) });
    };
    recompute();
    const id = setInterval(recompute, RECOMPUTE_MS);
    return () => clearInterval(id);
  }, [satrec]);

  const clear = useCallback(() => setTracked(null), [setTracked]);

  // Gate the returned geometry on `satrec` so a stale `computed` never leaks through after a clear/switch.
  return {
    trackedNoradId,
    name: active?.name ?? null,
    segments: satrec ? computed.segments : EMPTY_SEGMENTS,
    subPoint: satrec ? computed.subPoint : null,
    clear,
  };
}
