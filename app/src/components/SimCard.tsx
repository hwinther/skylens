/**
 * The cockpit view's detail card, shared by the web and Android screens: the AR view's own detail
 * sheets (DetailSheet / VesselDetailSheet / SatelliteDetailSheet on the shared non-modal Sheet, so the
 * same collapsed summary → expand behaviour, opaque surface on native, Escape / Android back to close).
 *
 * It shows the followed object at first. Tapping another aircraft or vessel in the 3D scene swaps it in,
 * with a "Follow this" action in place of "Cockpit view": following only ever happens on that explicit
 * press, never on the tap. The followed object's own card has no cockpit action (it is what is shown).
 * Other traffic's summary distance is measured from the followed object, not from the user.
 */

import { alpha, color } from "@/theme";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import type { RouteResponse } from "@/api/types";
import { useVesselStore } from "@/state/vesselStore";
import type { SimTarget } from "@/state/simStore";
import { DetailSheet } from "./DetailSheet";
import { useObserver } from "./useObserver";
import { SatelliteDetailSheet } from "./SatelliteDetailSheet";
import { sheetActionStyle } from "./Sheet";
import type { SimSelection } from "./useSimCockpit";
import { VesselDetailSheet } from "./VesselDetailSheet";

export interface SimCardProps {
  /** The followed object. */
  target: SimTarget;
  /** What the card shows, or null for no card. */
  selection: SimSelection | null;
  onClose: () => void;
  onFollow: (next: SimTarget) => void;
  /** The followed object's signal is lost (its card says so, as in the AR view). */
  followedLost: boolean;
  /** The followed object's position: other traffic's distance is measured from it. */
  origin: { lat: number; lon: number } | null;
  onRoute: (hex: string, route: RouteResponse) => void;
}

function FollowButton({ next, accent, onFollow }: { next: SimTarget; accent: string; onFollow: (t: SimTarget) => void }) {
  return (
    <Pressable
      testID="sim-follow"
      role="button"
      accessibilityLabel="Follow this in the cockpit view"
      style={[styles.follow, { backgroundColor: alpha(accent, 0.16), borderColor: accent }, sheetActionStyle]}
      onPress={() => onFollow(next)}
    >
      <Text style={[styles.followText, { color: accent }]}>Follow this</Text>
    </Pressable>
  );
}

export function SimCard({ target, selection, onClose, onFollow, followedLost, origin, onRoute }: SimCardProps) {
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const followed = !!selection && selection.kind === target.kind && selection.id === target.id;
  const hex = selection?.kind === "aircraft" ? selection.id : null;
  const mmsi = selection?.kind === "vessel" ? selection.id : null;
  const noradId = selection?.kind === "satellite" ? Number(selection.id) : null;
  const vessel = useVesselStore((s) => (mmsi ? s.byMmsi[mmsi] : undefined));
  // A satellite's next pass over the user, as on its AR card.
  const observer = useObserver();
  const action = (accent: string) =>
    followed || !selection ? null : <FollowButton next={selection} accent={accent} onFollow={onFollow} />;

  return (
    <>
      <DetailSheet
        hex={hex}
        client={client}
        onClose={onClose}
        signalLost={followed && followedLost}
        cockpitAction={action(color.entity.air)}
        relativeTo={followed ? null : origin}
        onRoute={onRoute}
      />
      <VesselDetailSheet
        mmsi={mmsi}
        vessel={vessel}
        onClose={onClose}
        signalLost={followed && followedLost}
        cockpitAction={action(color.entity.sea)}
        relativeTo={followed ? null : origin}
      />
      <SatelliteDetailSheet noradId={noradId} observer={observer} onClose={onClose} cockpitAction={null} />
    </>
  );
}

const styles = StyleSheet.create({
  follow: {
    alignItems: "center",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  followText: { fontSize: 15, fontWeight: "700" },
});
