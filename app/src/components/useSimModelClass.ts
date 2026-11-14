/**
 * The followed object's 3D model class for the cockpit view's outside camera (src/sim/modelClass.ts),
 * from the live stores: an aircraft's type designator / emitter category, a vessel's AIS ship type.
 * Resolved here, on the app side, so the Android globe (a DOM-component webview) only gets the class key
 * as a prop. Re-renders only when the class itself changes. Null until the object's data is in (the
 * globe keeps its point + chevron marker meanwhile); after that it sticks to the last known class while
 * the object is briefly missing from the store, so the model is not dropped and reloaded.
 */

import { useState } from "react";
import { simModelClass } from "@/sim/modelClass";
import type { SimModelClass } from "@/sim/models";
import { useAircraftStore } from "@/state/aircraftStore";
import type { SimTarget } from "@/state/simStore";
import { useVesselStore } from "@/state/vesselStore";

export function useSimModelClass(target: SimTarget | null): SimModelClass | null {
  const kind = target?.kind;
  const id = target?.id ?? "";
  const aircraft = useAircraftStore((s) => {
    if (kind !== "aircraft") return null;
    const ac = s.byHex[id];
    return ac ? simModelClass("aircraft", ac) : null;
  });
  const vessel = useVesselStore((s) => {
    if (kind !== "vessel") return null;
    const v = s.byMmsi[id];
    return v ? simModelClass("vessel", v) : null;
  });
  const key = target ? `${target.kind}:${target.id}` : "";
  const now = kind === "satellite" ? "satellite" : (aircraft ?? vessel);
  // The last known class per target (state adjusted during render: no extra commit for the common case).
  const [last, setLast] = useState<{ key: string; cls: SimModelClass } | null>(null);
  if (now && (last?.key !== key || last.cls !== now)) setLast({ key, cls: now });
  return now ?? (last?.key === key ? last.cls : null);
}
