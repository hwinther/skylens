/**
 * A stand-in for the SignalR HubConnection, for tests that mock `createAircraftHubConnection` (the
 * module boundary in src/api/signalr.ts) and keep the rest of that module real: onSnapshot/onVessels/
 * onStatus register through `on`/`off` and `subscribe` goes through `invoke`, as in production.
 *
 * The test drives the server side: `emit` pushes a hub message, `fireClose`/`fireReconnecting`/
 * `fireReconnected` play the connection lifecycle, and `startOutcomes` decides whether each start()
 * succeeds (undefined) or fails (an Error), in order; once it is empty every start succeeds.
 */
import { HubConnectionState, type HubConnection } from "@microsoft/signalr";

type Handler = (...args: unknown[]) => void;

export class FakeHub {
  state: HubConnectionState = HubConnectionState.Disconnected;
  readonly startOutcomes: (Error | undefined)[] = [];
  private readonly handlers = new Map<string, Set<Handler>>();
  private closeCbs: (() => void)[] = [];
  private reconnectingCbs: (() => void)[] = [];
  private reconnectedCbs: (() => void)[] = [];

  readonly start = jest.fn(() => {
    this.state = HubConnectionState.Connecting;
    const outcome = this.startOutcomes.shift();
    // Like the real client: Connecting until the handshake settles, Connected just before start() resolves.
    return Promise.resolve().then(() => {
      if (outcome) {
        this.state = HubConnectionState.Disconnected;
        throw outcome;
      }
      this.state = HubConnectionState.Connected;
    });
  });
  readonly stop = jest.fn(() => {
    this.state = HubConnectionState.Disconnected;
    return Promise.resolve();
  });
  readonly invoke = jest.fn((..._args: unknown[]) => Promise.resolve());

  on(name: string, handler: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
  }
  off(name: string, handler: Handler) {
    this.handlers.get(name)?.delete(handler);
  }
  onclose(cb: () => void) {
    this.closeCbs.push(cb);
  }
  onreconnecting(cb: () => void) {
    this.reconnectingCbs.push(cb);
  }
  onreconnected(cb: () => void) {
    this.reconnectedCbs.push(cb);
  }

  /** Server → client message. */
  emit(name: string, ...args: unknown[]) {
    for (const h of this.handlers.get(name) ?? []) h(...args);
  }
  /** Number of handlers still registered for a message (0 after the hook cleaned up). */
  listeners(name: string) {
    return this.handlers.get(name)?.size ?? 0;
  }
  fireReconnecting() {
    this.state = HubConnectionState.Reconnecting;
    for (const cb of this.reconnectingCbs) cb();
  }
  fireReconnected() {
    this.state = HubConnectionState.Connected;
    for (const cb of this.reconnectedCbs) cb();
  }
  fireClose() {
    this.state = HubConnectionState.Disconnected;
    for (const cb of this.closeCbs) cb();
  }
  /** The Subscribe(lat, lon, radiusKm) calls sent so far. */
  subscriptions() {
    return this.invoke.mock.calls.filter((c) => c[0] === "Subscribe").map((c) => c.slice(1));
  }

  asConnection(): HubConnection {
    return this as unknown as HubConnection;
  }
}
