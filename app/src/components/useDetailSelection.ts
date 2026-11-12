/**
 * The one selected object a screen shows a detail card for. The cards are non-modal (the scene stays
 * tappable while one is open), so selecting something of another kind must replace the open card
 * instead of stacking a second one on top: a single selection slot enforces "one card per screen".
 */
import { useCallback, useMemo, useState } from "react";

export type DetailKind = "aircraft" | "vessel" | "satellite" | "planet" | "radio" | "airport";

export interface DetailSelection {
  kind: DetailKind;
  id: string;
}

const KINDS: readonly DetailKind[] = ["aircraft", "vessel", "satellite", "planet", "radio", "airport"];

/**
 * Pure transition, exported for tests: selecting replaces whatever is selected; clearing (id null)
 * only clears when that kind is the one selected, so a stale onClose can't close another card.
 */
export function nextSelection(
  current: DetailSelection | null,
  kind: DetailKind,
  id: string | null,
): DetailSelection | null {
  if (id == null) return current?.kind === kind ? null : current;
  return { kind, id };
}

export function useDetailSelection() {
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  /** Stable per-kind setters with the same shape as the old per-kind useState setters. */
  const set = useMemo(
    () =>
      Object.fromEntries(
        KINDS.map((kind) => [
          kind,
          (id: string | null) => setSelection((cur) => nextSelection(cur, kind, id)),
        ]),
      ) as Record<DetailKind, (id: string | null) => void>,
    [],
  );
  const idOf = useCallback(
    (kind: DetailKind): string | null => (selection?.kind === kind ? selection.id : null),
    [selection],
  );
  return { selection, open: selection != null, idOf, set };
}
