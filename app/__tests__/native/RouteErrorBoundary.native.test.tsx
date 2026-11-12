/**
 * RouteErrorBoundary is what expo-router renders in place of a route that threw. The behaviour that
 * matters: the user sees the error and two ways out (retry the route, or go to the start), and the
 * crash is reported to /api/client-log exactly once, with token-shaped text scrubbed.
 */
import { render, screen, fireEvent } from "@testing-library/react-native";
import { router } from "expo-router";
import * as clientLog from "@/api/clientLog";
import { RouteErrorBoundary, renderErrorDetail } from "@/components/RouteErrorBoundary";

describe("RouteErrorBoundary", () => {
  beforeEach(() => {
    clientLog.resetClientLog();
  });

  it("shows the error and retries the route", async () => {
    const retry = jest.fn(() => Promise.resolve());
    await render(<RouteErrorBoundary error={new Error("radar exploded")} retry={retry} />);

    expect(screen.getByTestId("route-error")).toBeOnTheScreen();
    expect(screen.getByTestId("route-error-message")).toHaveTextContent("radar exploded");

    await fireEvent.press(screen.getByTestId("route-error-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("goes to the start, then clears the error", async () => {
    const retry = jest.fn(() => Promise.resolve());
    await render(<RouteErrorBoundary error={new Error("boom")} retry={retry} />);

    await fireEvent.press(screen.getByTestId("route-error-home"));
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("reports the error exactly once, across re-renders and remounts", async () => {
    const report = jest.spyOn(clientLog, "reportClientFailure");
    const flush = jest.spyOn(clientLog, "flushClientLog").mockResolvedValue();
    const error = new TypeError("Cannot read properties of undefined (reading 'lat')");
    const retry = jest.fn(() => Promise.resolve());

    await render(<RouteErrorBoundary error={error} retry={retry} />);
    await screen.rerender(<RouteErrorBoundary error={error} retry={retry} />);
    // The same error mounted again (e.g. React's dev double-mount) is not a second report.
    await screen.unmount();
    await render(<RouteErrorBoundary error={error} retry={retry} />);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      method: "RENDER",
      endpoint: "/",
      status: null,
      edgeMarkerPresent: false,
      detail: "TypeError: Cannot read properties of undefined (reading 'lat')",
    });
    expect(flush).toHaveBeenCalledTimes(1);

    // A different error is a new report.
    await screen.rerender(<RouteErrorBoundary error={new Error("again")} retry={retry} />);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("scrubs token-shaped text from the logged detail", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl";
    const detail = renderErrorDetail(
      new Error(`refresh failed for Bearer ${jwt} at /oauth?code=abc123&state=xyz`),
    );
    expect(detail).not.toContain(jwt);
    expect(detail).not.toContain("abc123");
    expect(detail).not.toContain("xyz");
    expect(detail).toContain("Error: refresh failed");
  });
});
