/** The /sim route's `kind` + `id` params as a simulator target (shared by the web and Android screens). */

import type { SimTarget } from "@/state/simStore";
import type { SimKind } from "./simPose";

const KINDS: readonly SimKind[] = ["aircraft", "vessel", "satellite"];

export function parseTarget(kind: unknown, id: unknown): SimTarget | null {
  if (typeof kind !== "string" || typeof id !== "string" || !id) return null;
  return (KINDS as readonly string[]).includes(kind) ? { kind: kind as SimKind, id } : null;
}
