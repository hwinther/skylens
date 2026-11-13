/**
 * AR identify — "what am I looking at?". Two ways in, one lookup pipeline (src/ar/identify.ts):
 *
 *  - Long-press anywhere on the AR view: the point under the finger becomes a ray (the inverse of the
 *    overlay's projection), matched once against the landmarks around the observer. A laser beam runs
 *    from the bottom of the view to a marker on the match, re-projected every frame so it stays on the
 *    landmark while the view moves. The result card stays until closed (or until a detail card opens).
 *  - Viewfinder toggle: a centre reticle; whatever the centre of the view points at is identified as
 *    the view moves, throttled (IDENTIFY_INTERVAL_MS, and only when the pose has moved) against the
 *    landmarks prepared once per observer — never one request per frame.
 *
 * The long-press catcher (ArIdentifyTouch) is the overlay's underlay, beneath its labels, so taps on
 * labels still open their cards, and a drag (demo / web drag-to-look) fails the long-press before it fires. The
 * beam, reticle, result card and toggle (ArIdentifyLayer) sit above the overlay.
 */

import { alpha, color, font, radius, space } from "@/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-worklets";
import type { ApiClient } from "@/api/client";
import {
  effectiveHFovDeg,
  FINGER_TOLERANCE_DEG,
  identifyAt,
  prepareLandmarks,
  project,
  RETICLE_TOLERANCE_DEG,
  screenToNdc,
  unproject,
  type CameraPose,
  type IdentifyObserver,
  type IdentifyRay,
  type IdentifyResult,
  type PreparedLandmark,
  type ProjectionConfig,
} from "@/ar";
import { DRAG_SLOP_PX } from "./dragSlop";
import { useLandmarks, type LandmarksStatus } from "./useLandmarks";
import {
  identifyAccessibleLabel,
  identifyAlternatives,
  identifySummary,
} from "./identifyFormat";

/** How long a press must be held to identify (a little under RN's 500 ms default, still clearly a hold). */
export const LONG_PRESS_MS = 450;
/** Viewfinder re-identify cadence; between ticks the pose must also have moved VIEWFINDER_MIN_MOVE_DEG. */
export const IDENTIFY_INTERVAL_MS = 250;
const VIEWFINDER_MIN_MOVE_DEG = 0.2;
/** Beam/marker repositioning cadence (same budget as the overlay's ~20 fps). */
const FRAME_MS = 1000 / 20;
/** The beam starts this far above the bottom of the view (where a hand-held pointer would be). */
const BEAM_ORIGIN_INSET = 12;

function projectionConfig(hFovDeg: number, width: number, height: number): ProjectionConfig {
  return { hFovDeg: effectiveHFovDeg(hFovDeg, width / height), aspect: width / height, cullMargin: 0.15 };
}

// --- State hook -----------------------------------------------------------------------------------------

export interface UseArIdentifyOptions {
  client: ApiClient;
  /** Demo home in demo mode, else the live fix; null until known. */
  observer: IdentifyObserver | null;
  demoMode: boolean;
  /** True while a detail card (aircraft, vessel, …) is open: identify steps aside. */
  detailOpen: boolean;
  /** Closes the open detail card; a long-press replaces it. */
  closeDetail: () => void;
  poseRef: React.MutableRefObject<CameraPose>;
  hFovDeg: number;
}

export interface ArIdentifyState {
  viewfinder: boolean;
  toggleViewfinder: () => void;
  /** The long-pressed direction, or null. */
  pin: IdentifyRay | null;
  pinResult: IdentifyResult | null;
  clearPin: () => void;
  onLongPressAt: (x: number, y: number) => void;
  prepared: PreparedLandmark[];
  status: LandmarksStatus;
  attribution: string | null;
  demo: boolean;
}

export function useArIdentify({
  client,
  observer,
  demoMode,
  detailOpen,
  closeDetail,
  poseRef,
  hFovDeg,
}: UseArIdentifyOptions): ArIdentifyState {
  const { width, height } = useWindowDimensions();
  const [viewfinder, setViewfinder] = useState(false);
  const [pin, setPin] = useState<IdentifyRay | null>(null);
  // Nothing is fetched until identify is first used; after that the data stays warm for the session.
  const [used, setUsed] = useState(false);

  const lat = observer?.lat ?? null;
  const lon = observer?.lon ?? null;
  const alt = observer?.alt ?? 0;
  const fetchCentre = useMemo(() => (lat != null && lon != null ? { lat, lon } : null), [lat, lon]);
  const data = useLandmarks({ client, observer: fetchCentre, enabled: used, demoMode });

  const prepared = useMemo(
    () => (lat != null && lon != null ? prepareLandmarks({ lat, lon, alt }, data.landmarks) : []),
    [lat, lon, alt, data.landmarks],
  );
  const pinResult = useMemo(
    () => (pin ? identifyAt(prepared, pin, { toleranceDeg: FINGER_TOLERANCE_DEG }) : null),
    [pin, prepared],
  );

  // A detail card opening (a label was tapped) takes over: drop the pinned result.
  useEffect(() => {
    if (detailOpen) setPin(null);
  }, [detailOpen]);

  const toggleViewfinder = useCallback(() => {
    setUsed(true);
    setViewfinder((v) => !v);
  }, []);
  const clearPin = useCallback(() => setPin(null), []);
  const onLongPressAt = useCallback(
    (x: number, y: number) => {
      const { xNdc, yNdc } = screenToNdc(x, y, width, height);
      const ray = unproject(xNdc, yNdc, poseRef.current, projectionConfig(hFovDeg, width, height));
      setUsed(true);
      closeDetail();
      setPin(ray);
    },
    [width, height, poseRef, hFovDeg, closeDetail],
  );

  return {
    viewfinder,
    toggleViewfinder,
    pin,
    pinResult,
    clearPin,
    onLongPressAt,
    prepared,
    status: data.status,
    attribution: data.attribution,
    demo: data.demo,
  };
}

// --- Long-press catcher (under the overlay) -------------------------------------------------------------

/** Gesture test id, for gesture-handler's jest utilities. */
export const LONG_PRESS_GESTURE_ID = "ar-identify-longpress";
/** Movement (px) that turns a hold into a drag: the long-press fails, drag-to-look takes over. */
const LONG_PRESS_MAX_DIST = DRAG_SLOP_PX;

/**
 * A gesture-handler LongPress, not a Pressable: drag-to-look is a gesture-handler Pan, and on web the
 * Pan holds the pointer, so a Pressable under it never sees the release and fires a "long press" on
 * every tap and drag. In one gesture system the hold simply fails once the pointer moves.
 */
export function ArIdentifyTouch({ onLongPressAt }: { onLongPressAt: (x: number, y: number) => void }) {
  // Rebuilt only when the callback changes (it is memoised upstream: window size, FOV, open card).
  const gesture = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(LONG_PRESS_MS)
        .maxDistance(LONG_PRESS_MAX_DIST)
        .withTestId(LONG_PRESS_GESTURE_ID)
        .onStart((e) => {
          runOnJS(onLongPressAt)(e.x, e.y);
        }),
    [onLongPressAt],
  );
  return (
    <GestureDetector gesture={gesture}>
      {/* A gesture surface, not a control: screen-reader users get the viewfinder toggle instead. */}
      <View testID="ar-identify-touch" style={styles.touch} accessible={false} importantForAccessibility="no" />
    </GestureDetector>
  );
}

// --- Beam, reticle, result card, toggle (over the overlay) ---------------------------------------------

export interface ArIdentifyLayerProps {
  state: ArIdentifyState;
  poseRef: React.MutableRefObject<CameraPose>;
  hFovDeg: number;
  /** A detail card is open: hide the beam and the card (the reticle stays). */
  suppressed: boolean;
  /** Distance from the top of the view to place the result card (below the status strip / banners). */
  cardTop: number;
}

interface Marker {
  x: number;
  y: number;
}

export function ArIdentifyLayer({ state, poseRef, hFovDeg, suppressed, cardTop }: ArIdentifyLayerProps) {
  const { width, height } = useWindowDimensions();
  // The view is shorter than the window (tab bar); the beam starts at the bottom of the actual view.
  const [viewHeight, setViewHeight] = useState(height);
  const onLayout = useCallback((e: LayoutChangeEvent) => setViewHeight(e.nativeEvent.layout.height), []);

  const { viewfinder, pin, pinResult, prepared } = state;
  const [vfResult, setVfResult] = useState<IdentifyResult | null>(null);
  const [marker, setMarker] = useState<Marker | null>(null);

  // What the beam points at: the long-press match (or, with no match, the pressed point itself), else
  // the viewfinder match.
  const target: IdentifyRay | null = pin
    ? pinResult
      ? { azimuth: pinResult.best.azimuthDeg, elevation: pinResult.best.elevationDeg }
      : pin
    : viewfinder && vfResult
      ? { azimuth: vfResult.best.azimuthDeg, elevation: vfResult.best.elevationDeg }
      : null;

  const targetRef = useRef(target);
  const preparedRef = useRef(prepared);
  const viewfinderRef = useRef(viewfinder);
  const hFovRef = useRef(hFovDeg);
  useEffect(() => {
    targetRef.current = target;
    preparedRef.current = prepared;
    viewfinderRef.current = viewfinder;
    hFovRef.current = hFovDeg;
  });

  // Viewfinder off: forget its last match so it doesn't flash back on the next toggle.
  useEffect(() => {
    if (!viewfinder) setVfResult(null);
  }, [viewfinder]);

  useEffect(() => {
    let raf = 0;
    let lastFrame = 0;
    let lastIdentify = 0;
    let lastPose: CameraPose | null = null;
    let lastPrepared: PreparedLandmark[] | null = null;
    let lastKey = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = Date.now();
      if (now - lastFrame < FRAME_MS) return;
      lastFrame = now;
      const pose = poseRef.current;
      const config = projectionConfig(hFovRef.current, width, height);

      // Viewfinder: re-identify the centre ray when the pose moved (or the data changed), throttled.
      if (viewfinderRef.current && now - lastIdentify >= IDENTIFY_INTERVAL_MS) {
        const moved =
          !lastPose ||
          Math.abs(pose.azimuth - lastPose.azimuth) > VIEWFINDER_MIN_MOVE_DEG ||
          Math.abs(pose.elevation - lastPose.elevation) > VIEWFINDER_MIN_MOVE_DEG;
        if (moved || lastPrepared !== preparedRef.current) {
          lastIdentify = now;
          lastPose = pose;
          lastPrepared = preparedRef.current;
          const res = identifyAt(
            preparedRef.current,
            { azimuth: pose.azimuth, elevation: pose.elevation },
            { toleranceDeg: RETICLE_TOLERANCE_DEG },
          );
          // Re-render only when the answer changes, not for every small move.
          const key = res ? `${res.best.landmark.id}|${res.alternatives.map((a) => a.landmark.id).join(",")}` : "";
          if (key !== lastKey) {
            lastKey = key;
            setVfResult(res);
          }
        }
      } else if (!viewfinderRef.current) {
        lastPose = null;
        lastKey = "";
      }

      const t = targetRef.current;
      if (!t) {
        setMarker((m) => (m ? null : m));
        return;
      }
      const p = project(t, pose, config);
      if (!p.onScreen) {
        setMarker((m) => (m ? null : m));
        return;
      }
      const x = (p.xNdc * width) / 2 + width / 2;
      const y = height / 2 - (p.yNdc * height) / 2;
      setMarker((m) => (m && Math.abs(m.x - x) < 0.5 && Math.abs(m.y - y) < 0.5 ? m : { x, y }));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [poseRef, width, height]);

  const active = pin != null || viewfinder;
  const result = pin ? pinResult : viewfinder ? vfResult : null;
  const origin = { x: width / 2, y: viewHeight - BEAM_ORIGIN_INSET };

  return (
    <View style={styles.layer} onLayout={onLayout}>
      {viewfinder ? (
        <View
          testID="ar-identify-reticle"
          style={[styles.reticle, { left: width / 2 - RETICLE / 2, top: height / 2 - RETICLE / 2 }]}
        >
          <View style={styles.reticleDot} />
        </View>
      ) : null}

      {!suppressed && marker ? (
        <>
          <Beam from={origin} to={marker} />
          <View
            testID="ar-identify-marker"
            style={[
              styles.marker,
              !result && styles.markerEmpty,
              { left: marker.x - MARKER / 2, top: marker.y - MARKER / 2 },
            ]}
          />
        </>
      ) : null}

      {active && !suppressed ? (
        <IdentifyCard
          state={state}
          result={result}
          top={cardTop}
          mode={pin ? "pin" : "viewfinder"}
        />
      ) : null}

      <Pressable
        testID="ar-identify-toggle"
        onPress={state.toggleViewfinder}
        role="switch"
        aria-checked={viewfinder}
        accessibilityLabel="Identify what the centre of the view points at"
        accessibilityHint="Shows a reticle. You can also long-press anywhere on the view to identify one point."
        hitSlop={8}
        style={[styles.toggle, viewfinder && styles.toggleOn]}
      >
        <MaterialCommunityIcons
          name={viewfinder ? "crosshairs-gps" : "crosshairs"}
          size={24}
          color={viewfinder ? color.bg : color.laser}
        />
      </Pressable>
    </View>
  );
}

const RETICLE = 36;
const MARKER = 14;
const BEAM_CORE = 2;
const BEAM_GLOW = 8;

/** A straight line drawn with two rotated Views: a soft glow under a thin bright core. */
function Beam({ from, to }: { from: Marker; to: Marker }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const angle = Math.atan2(dy, dx);
  const cx = (from.x + to.x) / 2;
  const cy = (from.y + to.y) / 2;
  const line = (thickness: number) => ({
    left: cx - length / 2,
    top: cy - thickness / 2,
    width: length,
    height: thickness,
    transform: [{ rotate: `${angle}rad` }],
  });
  return (
    <View testID="ar-identify-beam" style={styles.beam}>
      <View style={[styles.beamGlow, line(BEAM_GLOW)]} />
      <View style={[styles.beamCore, line(BEAM_CORE)]} />
    </View>
  );
}

function IdentifyCard({
  state,
  result,
  top,
  mode,
}: {
  state: ArIdentifyState;
  result: IdentifyResult | null;
  top: number;
  mode: "pin" | "viewfinder";
}) {
  const { status, attribution } = state;
  let title: string;
  let summary: string | null = null;
  let extra: string | null = null;
  if (status === "loading" || status === "idle") {
    title = "Looking up landmarks…";
  } else if (status === "unavailable") {
    title = "Landmarks unavailable";
    summary = "Sign in, or try again when online.";
  } else if (result) {
    title = result.best.landmark.name;
    summary = identifySummary(result.best);
    extra = identifyAlternatives(result);
  } else {
    title = mode === "pin" ? "Nothing named in that direction" : "Aim the reticle at a peak or a town";
  }
  const label = result ? identifyAccessibleLabel(result) : title;
  // Live region: Android announces changes; on web role="status" is a polite live region.
  const live = Platform.OS === "web" ? { role: "status" as const, "aria-live": "polite" as const } : {};

  return (
    <View
      testID="ar-identify-result"
      style={[styles.card, { top }]}
      accessible
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      {...live}
    >
      <View style={styles.cardRow}>
        <MaterialCommunityIcons
          name={result ? (result.best.landmark.kind === "peak" ? "image-filter-hdr" : "home-city-outline") : "crosshairs-question"}
          size={18}
          color={color.laser}
        />
        <Text testID="ar-identify-name" style={styles.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        {mode === "pin" ? (
          <Pressable
            testID="ar-identify-close"
            onPress={state.clearPin}
            hitSlop={10}
            role="button"
            accessibilityLabel="Close"
            style={styles.close}
          >
            <MaterialCommunityIcons name="close" size={18} color={color.textDim} />
          </Pressable>
        ) : null}
      </View>
      {summary ? <Text style={styles.cardSummary}>{summary}</Text> : null}
      {extra ? (
        <Text style={styles.cardExtra} numberOfLines={1}>
          {extra}
        </Text>
      ) : null}
      {result ? (
        <Text style={styles.cardNote}>
          Nearest named feature that way{state.demo ? " (demo sample)" : ""} · {attribution}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  touch: { ...StyleSheet.absoluteFill },
  layer: { ...StyleSheet.absoluteFill, pointerEvents: "box-none" },
  beam: { ...StyleSheet.absoluteFill, pointerEvents: "none" },
  reticle: {
    position: "absolute",
    width: RETICLE,
    height: RETICLE,
    borderRadius: RETICLE / 2,
    borderWidth: 2,
    borderColor: alpha(color.laser, 0.9),
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
  reticleDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: color.laser },
  beamGlow: { position: "absolute", borderRadius: BEAM_GLOW / 2, backgroundColor: alpha(color.laser, 0.22) },
  beamCore: { position: "absolute", borderRadius: BEAM_CORE / 2, backgroundColor: alpha(color.laser, 0.95) },
  marker: {
    position: "absolute",
    width: MARKER,
    height: MARKER,
    borderRadius: MARKER / 2,
    backgroundColor: color.laser,
    borderWidth: 2,
    borderColor: color.text,
    pointerEvents: "none",
  },
  markerEmpty: { backgroundColor: "transparent", borderColor: alpha(color.laser, 0.9) },
  card: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    maxWidth: 380,
    marginHorizontal: "auto",
    backgroundColor: alpha(color.bg, 0.92),
    borderColor: alpha(color.laser, 0.55),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.xxs,
  },
  cardRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardTitle: { flex: 1, color: color.text, fontSize: font.control, fontWeight: "700" },
  cardSummary: { color: color.textDim, fontSize: font.label },
  cardExtra: { color: color.textLabel, fontSize: font.label },
  cardNote: { color: color.textMuted, fontSize: font.micro },
  close: { padding: space.xxs },
  toggle: {
    position: "absolute",
    right: space.lg,
    bottom: space.lg,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: alpha(color.bg, 0.85),
    borderColor: alpha(color.laser, 0.6),
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggleOn: { backgroundColor: color.laser, borderColor: color.laser },
});
