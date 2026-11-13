/**
 * The Pressable every AR label uses: a tap opens the label's card, a drag that happens to start on the
 * label does not.
 *
 * Why it's needed: drag-to-look is a gesture-handler Pan on the view under the labels. On web the Pan
 * calls setPointerCapture on the pressed element, so when a drag starts on a label every later pointer
 * event, the release included, targets that label, and the browser then dispatches a `click` on it.
 * react-native-web wires Pressable's onPress to the DOM `click` (not to the responder release), so the
 * end of the drag opened the label's detail card. On Android the Pan cancels the JS responder once it
 * activates, so the Pressable never fires there; the guard below is harmless on native.
 *
 * So: remember where the press started (pointer down / press in) and drop an onPress whose pointer
 * moved more than DRAG_SLOP_PX. A press without coordinates (keyboard Enter/Space, an assistive-tech
 * activation) has nothing to compare and always goes through.
 */

import { forwardRef, useCallback, useRef, type ComponentRef } from "react";
import { Pressable, type GestureResponderEvent, type PressableProps } from "react-native";
import { movedBeyondSlop, pagePoint, type PagePoint } from "./dragSlop";

type PointerDownHandler = NonNullable<PressableProps["onPointerDown"]>;

export const LabelPressable = forwardRef<ComponentRef<typeof Pressable>, PressableProps>(function LabelPressable(
  { onPress, onPressIn, onPointerDown, ...rest },
  ref,
) {
  const startRef = useRef<PagePoint | null>(null);

  // Pointer down comes first on web (before gesture-handler captures the pointer); press-in is the
  // native path. Either one records the start; both carry the same position.
  const handlePointerDown = useCallback<PointerDownHandler>(
    (e) => {
      startRef.current = pagePoint(e);
      onPointerDown?.(e);
    },
    [onPointerDown],
  );
  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      startRef.current = pagePoint(e) ?? startRef.current;
      onPressIn?.(e);
    },
    [onPressIn],
  );
  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      const start = startRef.current;
      startRef.current = null;
      const end = pagePoint(e);
      if (start && end && movedBeyondSlop(start, end)) return; // a drag, not a tap
      onPress?.(e);
    },
    [onPress],
  );

  return (
    <Pressable
      ref={ref}
      {...rest}
      onPointerDown={handlePointerDown}
      onPressIn={handlePressIn}
      onPress={onPress ? handlePress : undefined}
    />
  );
});
