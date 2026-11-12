/**
 * Shared mocks for the `native` jest project (component tests on the full jest-expo preset).
 *
 * Only the native edges are replaced: maps, camera, sensors, location, fonts, gestures/animation
 * runtimes and the router. Screens, components, hooks and zustand stores run for real, and tests
 * seed data through the stores.
 * Nothing here touches the network: tests leave the API gated (auth required, no session), so the
 * data hooks fetch nothing, and fetch itself fails loudly if something tries anyway.
 */
import "react-native-gesture-handler/jestSetup";
import type { ReactNode } from "react";
import { useAuthStore } from "@/state/authStore";

// Props the map shape mocks forward (named mock* so jest.mock factories may reference it).
type MockMapProps = { testID?: string; onPress?: () => void; children?: ReactNode };

// react-native-maps: plain Views (Pressables when given onPress) that keep testID / onPress /
// children, so a marker is pressable in a test and the map's children (markers, polylines) still
// render. Imperative camera methods are no-op mocks.
jest.mock("react-native-maps", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Pressable, View } = jest.requireActual<typeof import("react-native")>("react-native");
  const shape = (name: string) => {
    const C = ({ testID, onPress, children }: MockMapProps) =>
      onPress
        ? React.createElement(Pressable, { testID, onPress }, children)
        : React.createElement(View, { testID }, children);
    C.displayName = name;
    return C;
  };
  const MapView = React.forwardRef<unknown, MockMapProps & { onMapReady?: () => void }>(
    function MapView({ testID, children, onMapReady }, ref) {
      React.useImperativeHandle(ref, () => ({
        animateCamera: jest.fn(),
        animateToRegion: jest.fn(),
        fitToCoordinates: jest.fn(),
      }));
      React.useEffect(() => {
        onMapReady?.();
      }, [onMapReady]);
      return React.createElement(View, { testID: testID ?? "native-map" }, children);
    },
  );
  return {
    __esModule: true,
    default: MapView,
    Marker: shape("Marker"),
    Polygon: shape("Polygon"),
    Polyline: shape("Polyline"),
    Circle: shape("Circle"),
    Callout: shape("Callout"),
    PROVIDER_GOOGLE: "google",
  };
});

// Reanimated / worklets have no native runtime under jest: use the mocks both libraries ship (the
// gesture handler's own jest setup is imported above).
jest.mock("react-native-worklets", () => jest.requireActual("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => jest.requireActual("react-native-reanimated/mock"));

// @expo/vector-icons loads its icon font on mount through expo-font/expo-asset, which has no asset
// registry under jest. Report every font as loaded, so the icons render their glyphs right away.
jest.mock("expo-font", () => ({
  ...jest.requireActual<object>("expo-font"),
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));

jest.mock("expo-camera", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    CameraView: View,
    useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn(), jest.fn()],
  };
});

jest.mock("expo-sensors", () => ({
  DeviceMotion: {
    isAvailableAsync: jest.fn(() => Promise.resolve(false)),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    setUpdateInterval: jest.fn(),
  },
}));

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3, High: 4 },
  requestForegroundPermissionsAsync: jest.fn(() => Promise.resolve({ status: "denied", granted: false })),
  getForegroundPermissionsAsync: jest.fn(() => Promise.resolve({ status: "denied", granted: false })),
  watchPositionAsync: jest.fn(() => Promise.resolve({ remove: jest.fn() })),
  getLastKnownPositionAsync: jest.fn(() => Promise.resolve(null)),
}));

// expo-router: no navigator in a component test. `useFocusEffect` treats the screen as focused (runs
// the callback as an effect, cleanup on change/unmount), which is what the detail cards' back/Escape
// handlers need. `router` is one shared object so tests can assert navigation calls.
jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    navigate: jest.fn(),
    canGoBack: jest.fn(() => false),
    setParams: jest.fn(),
  };
  return {
    router,
    useRouter: () => router,
    usePathname: jest.fn(() => "/"),
    useLocalSearchParams: jest.fn(() => ({})),
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  // Signed out behind real auth: every API caller is gated off, so no REST call or hub connection.
  useAuthStore.setState({ status: "unauthenticated", authRequired: true });
  jest.spyOn(globalThis, "fetch").mockImplementation((input) =>
    Promise.reject(new Error(`unexpected network call in a component test: ${String(input)}`)),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});
