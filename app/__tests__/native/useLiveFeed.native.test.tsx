/**
 * useLiveFeed: the app-wide SignalR feed. Only the connection factory is mocked (FakeHub stands in
 * for the HubConnection); the message registration, Subscribe call and the zustand stores are real.
 *
 * What depends on it: every tab reads the aircraft/vessel stores it fills; the status strip reads the
 * connection state; switching to demo or signing out must not leave live traffic on screen; a hub
 * that fails to start must keep retrying instead of leaving the app connected to nothing.
 */
import { act, renderHook } from "@testing-library/react-native";
import { createAircraftHubConnection, RECONNECT_DELAYS_MS } from "@/api/signalr";
import { useLiveFeed, type UseLiveFeedOptions } from "@/components/useLiveFeed";
import { useAircraftStore } from "@/state/aircraftStore";
import { useAuthStore } from "@/state/authStore";
import { useVesselStore } from "@/state/vesselStore";
import type { VesselDto } from "@/api/types";
import { aircraft, resetStores } from "./fixtures";
import { FakeHub } from "./fakeHub";

jest.mock("@/api/signalr", () => ({
  ...jest.requireActual<object>("@/api/signalr"),
  createAircraftHubConnection: jest.fn(),
}));

const createHub = jest.mocked(createAircraftHubConnection);
let hubs: FakeHub[] = [];
const lastHub = () => hubs[hubs.length - 1];

const OSLO = { lat: 59.9, lon: 10.75 };
const BASE: UseLiveFeedOptions = { enabled: true, baseUrl: "http://api.test", observer: OSLO, radiusKm: 60 };

const ship: VesselDto = { mmsi: "257000001", lat: 59.9, lon: 10.7, kind: "ship" } as VesselDto;

async function renderFeed(opts: Partial<UseLiveFeedOptions> = {}) {
  const hook = await renderHook((p: UseLiveFeedOptions) => useLiveFeed(p), {
    initialProps: { ...BASE, ...opts },
  });
  return hook;
}

const connection = () => useAircraftStore.getState().connection;
const hexes = () => Object.keys(useAircraftStore.getState().byHex);

describe("useLiveFeed", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
    useAircraftStore.setState({ connection: "disconnected", source: "demo" });
    hubs = [];
    createHub.mockImplementation(() => {
      const hub = new FakeHub();
      hubs.push(hub);
      return hub.asConnection();
    });
    // The expected start-failure warnings.
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("opens no connection while disabled (demo mode, or signed out behind auth)", async () => {
    await renderFeed({ enabled: false });
    expect(createHub).not.toHaveBeenCalled();
    expect(useAircraftStore.getState().source).toBe("demo");
  });

  it("connects, subscribes at the observer, and feeds the stores from hub messages", async () => {
    await renderFeed();

    expect(createHub).toHaveBeenCalledWith({ baseUrl: "http://api.test" });
    expect(useAircraftStore.getState().source).toBe("live");
    expect(connection()).toBe("connected");
    expect(lastHub().subscriptions()).toEqual([[59.9, 10.75, 60]]);

    await act(async () => lastHub().emit("snapshot", [aircraft("abc123"), aircraft("def456")]));
    expect(hexes()).toEqual(["abc123", "def456"]);

    await act(async () => lastHub().emit("vessels", [ship]));
    expect(Object.keys(useVesselStore.getState().byMmsi)).toEqual(["257000001"]);

    // A status frame: no aircraft this tick, with a reason; the ships (5 s cadence) stay.
    await act(async () => lastHub().emit("status", { reason: "away-unavailable" }));
    expect(hexes()).toEqual([]);
    expect(useAircraftStore.getState().feedStatus).toBe("away-unavailable");
    expect(Object.keys(useVesselStore.getState().byMmsi)).toEqual(["257000001"]);
  });

  it("waits for a position before subscribing, and re-subscribes when it or the radius changes", async () => {
    const hook = await renderFeed({ observer: null });
    expect(connection()).toBe("connected");
    expect(lastHub().subscriptions()).toEqual([]);

    await hook.rerender({ ...BASE, observer: OSLO });
    await hook.rerender({ ...BASE, observer: OSLO, radiusKm: 100 });

    expect(lastHub().subscriptions()).toEqual([
      [59.9, 10.75, 60],
      [59.9, 10.75, 100],
    ]);
    // Moving the subscription never rebuilds the connection.
    expect(hubs).toHaveLength(1);
  });

  it("retries a failed start on the backoff schedule", async () => {
    createHub.mockImplementationOnce(() => {
      const hub = new FakeHub();
      hub.startOutcomes.push(new Error("503"), new Error("503"));
      hubs.push(hub);
      return hub.asConnection();
    });
    await renderFeed();
    const hub = lastHub();
    expect(hub.start).toHaveBeenCalledTimes(1);
    expect(connection()).toBe("disconnected");

    // First retry after RECONNECT_DELAYS_MS[1] (2 s), not immediately.
    await act(async () => jest.advanceTimersByTime(RECONNECT_DELAYS_MS[1] - 1));
    expect(hub.start).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(1));
    expect(hub.start).toHaveBeenCalledTimes(2);

    // Second failure backs off further (5 s), then the start succeeds and subscribes.
    await act(async () => jest.advanceTimersByTime(RECONNECT_DELAYS_MS[2]));
    expect(hub.start).toHaveBeenCalledTimes(3);
    expect(connection()).toBe("connected");
    expect(hub.subscriptions()).toEqual([[59.9, 10.75, 60]]);
  });

  it("mirrors reconnecting, and re-subscribes once reconnected", async () => {
    await renderFeed();
    const hub = lastHub();

    await act(async () => hub.fireReconnecting());
    expect(connection()).toBe("reconnecting");

    await act(async () => hub.fireReconnected());
    expect(connection()).toBe("connected");
    // The server forgets the subscription with the old connection id: subscribe again.
    expect(hub.subscriptions()).toHaveLength(2);
  });

  it("drops the ships and starts over when the connection closes for good", async () => {
    await renderFeed();
    const hub = lastHub();
    await act(async () => hub.emit("vessels", [ship]));

    await act(async () => hub.fireClose());
    expect(connection()).toBe("disconnected");
    expect(useVesselStore.getState().byMmsi).toEqual({});

    await act(async () => jest.advanceTimersByTime(RECONNECT_DELAYS_MS[0]));
    expect(hub.start).toHaveBeenCalledTimes(2);
    expect(connection()).toBe("connected");
  });

  it("clears the live traffic and stops the hub when turned off", async () => {
    const hook = await renderFeed();
    const hub = lastHub();
    await act(async () => {
      hub.emit("snapshot", [aircraft("abc123")]);
      hub.emit("vessels", [ship]);
    });

    await hook.rerender({ ...BASE, enabled: false });

    expect(hub.stop).toHaveBeenCalled();
    expect(hexes()).toEqual([]);
    expect(useVesselStore.getState().byMmsi).toEqual({});
    expect(connection()).toBe("disconnected");
    expect(hub.listeners("snapshot")).toBe(0);
    // A late close from the stopped connection doesn't restart it.
    await act(async () => {
      hub.fireClose();
      jest.advanceTimersByTime(60_000);
    });
    expect(hub.start).toHaveBeenCalledTimes(1);
  });

  it("reconnects with a fresh connection on sign-in, so the new token is used", async () => {
    useAuthStore.setState({ status: "unauthenticated", authRequired: false });
    await renderFeed();
    const first = lastHub();

    // The transient "authenticating" state doesn't flap the connection.
    await act(async () => useAuthStore.setState({ status: "authenticating" }));
    expect(hubs).toHaveLength(1);

    await act(async () => useAuthStore.setState({ status: "authenticated" }));
    expect(first.stop).toHaveBeenCalled();
    expect(hubs).toHaveLength(2);
    expect(lastHub().start).toHaveBeenCalled();
    expect(connection()).toBe("connected");
  });
});
