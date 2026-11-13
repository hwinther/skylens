/**
 * The "Overhead" satellites: what is above the observer's horizon right now, in the groups and above
 * the elevation mask the user chose in Settings. One hook for the List tab's Overhead section and the
 * Map's satellites layer, so the two can never disagree: both read the same settings (master
 * showSatellites, group toggles, mask) and go through the same useSatellites fetch → SGP4 → select
 * chain (gated by useApiAllowed inside it), ordered by overheadSatellites (highest first).
 */

import { useMemo } from "react";
import type { ApiClient } from "@/api/client";
import { overheadSatellites, satGroupsFromSettings, type Observer, type SatelliteView } from "@/ar";
import { useSettingsStore } from "@/state/settingsStore";
import { useSatellites, type SatelliteStatus } from "./useSatellites";

export interface UseOverheadSatellitesOptions {
  client: ApiClient;
  observer: Observer | null;
  /** Extra gate on top of the showSatellites master toggle (e.g. a per-view layer toggle). Default on. */
  enabled?: boolean;
}

export interface OverheadSatellites {
  /** Overhead satellites, highest in the sky first. */
  overhead: SatelliteView[];
  /** The same set keyed by NORAD id (detail card + footprint lookups). */
  byNoradId: Map<number, SatelliteView>;
  /** The elevation mask in force (the detail card's pass prediction uses it too). */
  elevationMaskDeg: number;
  status: SatelliteStatus;
}

export function useOverheadSatellites({
  client,
  observer,
  enabled = true,
}: UseOverheadSatellitesOptions): OverheadSatellites {
  const showSatellites = useSettingsStore((s) => s.showSatellites);
  const satAmateurStations = useSettingsStore((s) => s.satAmateurStations);
  const satWeather = useSettingsStore((s) => s.satWeather);
  const satGnss = useSettingsStore((s) => s.satGnss);
  const elevationMaskDeg = useSettingsStore((s) => s.satElevationMaskDeg);
  const groups = useMemo(
    () =>
      satGroupsFromSettings({
        amateurStations: satAmateurStations,
        weather: satWeather,
        gnss: satGnss,
      }),
    [satAmateurStations, satWeather, satGnss],
  );
  const { visible, byNoradId, status } = useSatellites({
    client,
    observer,
    enabled: showSatellites && enabled,
    groups,
    elevationMaskDeg,
  });
  const overhead = useMemo(() => overheadSatellites(visible), [visible]);
  return { overhead, byNoradId, elevationMaskDeg, status };
}
