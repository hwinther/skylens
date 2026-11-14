/**
 * The Pressable every AR label uses: a tap opens the label's card, a drag that happens to start on the
 * label does not, and a still hold identifies the direction under the finger (AR identify) instead of
 * opening the card.
 *
 * Tap vs drag: drag-to-look is a gesture-handler Pan on the view under the labels. On web the Pan
 * calls setPointerCapture on the pressed element, so when a drag starts on a label every later pointer
 * event, the release included, targets that label, and the browser then dispatches a `click` on it.
 * react-native-web wires Pressable's onPress to the DOM `click` (not to the responder release), so the
 * end of the drag opened the label's detail card. On Android the Pan cancels the JS responder once it
 * activates, so the Pressable never fires there; the guard below is harmless on native.
 * So: remember where the press started (pointer down / press in) and drop an onPress whose pointer
 * moved more than DRAG_SLOP_PX. A press without coordinates (keyboard Enter/Space, an assistive-tech
 * activation) has nothing to compare and always goes through.
 *
 * Hold to identify: labels sit above identify's long-press catcher (so their taps win), which used to
 * mean a hold that started on a label never identified anything, and on a real phone the peak you
 * point at is often behind a label. When the overlay provides LabelLongPressContext, a hold of
 * LONG_PRESS_MS that stays within the slop reports its start point (page coordinates) to identify, and
 * the release that follows does not open the card.
 *  - Native: Pressable's own onLongPress. Pressability starts the timer on press-in, cancels it when the
 *    finger moves past its slop or the Pan takes the responder, and skips onPress after a long press.
 *  - Web: our own timer on pointer events. react-native-web's onLongPress hangs off the responder
 *    system, which under the gesture-handler Pan never sees the release (a hold would fire on every
 *    tap: the pitfall that made identify's catcher a gesture-handler LongPress). Pointer events do
 *    arrive (the drag guard above relies on them), so: start on pointer down, cancel on a move past the
 *    slop or on pointer up / cancel, and swallow the click that follows a fired hold.
 */

import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, type ComponentRef } from "react";
import { Platform, Pressable, type GestureResponderEvent, type PressableProps } from "react-native";
import { LONG_PRESS_MS, movedBeyondSlop, pagePoint, type PagePoint } from "./dragSlop";

/** Receives a label hold's page coordinates (AR identify); null = labels have no hold action. */
export type LabelLongPressHandler = (pageX: number, pageY: number) => void;
export const LabelLongPressContext = createContext<LabelLongPressHandler | null>(null);

type PointerHandler = NonNullable<PressableProps["onPointerDown"]>;
type ContextMenuEvent = { preventDefault?: () => void };

const isWeb = Platform.OS === "web";

export const LabelPressable = forwardRef<ComponentRef<typeof Pressable>, PressableProps>(function LabelPressable(
  { onPress, onPressIn, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, ...rest },
  ref,
) {
  const onLongPressAt = useContext(LabelLongPressContext);
  const startRef = useRef<PagePoint | null>(null);
  // A hold fired for the current press: its release must not open the card.
  const heldRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  // A label leaving the screen mid-hold drops the hold: its release would never reach us.
  useEffect(() => clearTimer, [clearTimer]);

  const fireHold = useCallback(
    (at: PagePoint | null) => {
      if (!onLongPressAt || !at) return;
      heldRef.current = true;
      onLongPressAt(at.pageX, at.pageY);
    },
    [onLongPressAt],
  );

  // Pointer down comes first on web (before gesture-handler captures the pointer); press-in is the
  // native path. Either one records the start; both carry the same position.
  const handlePointerDown = useCallback<PointerHandler>(
    (e) => {
      const start = pagePoint(e);
      startRef.current = start;
      heldRef.current = false;
      clearTimer();
      const ne = e.nativeEvent as { button?: number; pointerType?: string };
      touchRef.current = ne.pointerType != null && ne.pointerType !== "mouse";
      // Primary button only: a right click is not a hold.
      if (isWeb && onLongPressAt && start && (ne.button == null || ne.button === 0)) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          fireHold(start);
        }, LONG_PRESS_MS);
      }
      onPointerDown?.(e);
    },
    [onPointerDown, onLongPressAt, clearTimer, fireHold],
  );
  const handlePointerMove = useCallback<PointerHandler>(
    (e) => {
      const start = startRef.current;
      const at = pagePoint(e);
      if (timerRef.current != null && start && at && movedBeyondSlop(start, at)) clearTimer();
      onPointerMove?.(e);
    },
    [onPointerMove, clearTimer],
  );
  const handlePointerUp = useCallback<PointerHandler>(
    (e) => {
      clearTimer();
      onPointerUp?.(e);
    },
    [onPointerUp, clearTimer],
  );
  const handlePointerCancel = useCallback<PointerHandler>(
    (e) => {
      clearTimer();
      onPointerCancel?.(e);
    },
    [onPointerCancel, clearTimer],
  );
  // A touch hold in a mobile browser: keep the browser's context menu / callout off the label.
  const handleContextMenu = useCallback((e: ContextMenuEvent) => {
    if (touchRef.current || heldRef.current) e.preventDefault?.();
  }, []);

  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      startRef.current = pagePoint(e) ?? startRef.current;
      // Web resets on pointer down (under the Pan a responder press-in may never come).
      if (!isWeb) heldRef.current = false;
      onPressIn?.(e);
    },
    [onPressIn],
  );
  const handleLongPress = useCallback(
    (e: GestureResponderEvent) => fireHold(pagePoint(e) ?? startRef.current),
    [fireHold],
  );
  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (heldRef.current) {
        heldRef.current = false; // the release of a hold that identified, not a tap
        return;
      }
      const end = pagePoint(e);
      if (start && end && movedBeyondSlop(start, end)) return; // a drag, not a tap
      onPress?.(e);
    },
    [onPress],
  );

  // Only labels inside an overlay that offers identify get the hold; elsewhere this is the plain
  // tap-vs-drag Pressable it always was.
  const holdProps: Partial<PressableProps> & { onContextMenu?: (e: ContextMenuEvent) => void } = !onLongPressAt
    ? { onPointerMove, onPointerUp, onPointerCancel }
    : isWeb
      ? {
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerCancel,
          // react-native-web forwards it to the DOM element; RN's Pressable types don't list it.
          onContextMenu: handleContextMenu,
        }
      : { onPointerMove, onPointerUp, onPointerCancel, onLongPress: handleLongPress, delayLongPress: LONG_PRESS_MS };

  return (
    <Pressable
      ref={ref}
      {...rest}
      {...(holdProps as Partial<PressableProps>)}
      onPointerDown={handlePointerDown}
      onPressIn={handlePressIn}
      onPress={onPress ? handlePress : undefined}
    />
  );
});
