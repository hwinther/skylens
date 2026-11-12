/**
 * Sheet is the shared, non-modal detail card. On a phone-width window it opens as a compact card
 * (header + one-line summary), expands to the full body, and closes from its close button or from
 * Android's hardware back button (registered only while the card is open on a focused screen).
 */
import { useState } from "react";
import { DeviceEventEmitter, StyleSheet, Text } from "react-native";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import { Sheet, SheetSummary } from "@/components/Sheet";
import { color } from "@/theme";

/** A screen that owns the open/closed state, like the real screens do through useDetailSelection. */
function Harness({ onClosed }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet
      visible={open}
      onClose={() => {
        setOpen(false);
        onClosed?.();
      }}
      accent="#4FC3F7"
      label="Aircraft details"
      header={<Text>SAS123</Text>}
      summary={<SheetSummary parts={["FL350", "450 kt", null]} />}
    >
      <Text testID="full-details">Registration LN-RKF</Text>
    </Sheet>
  );
}

/** What Android's native side does when the hardware back button is pressed. */
async function pressHardwareBack() {
  await act(async () => {
    DeviceEventEmitter.emit("hardwareBackPress");
  });
}

describe("Sheet (compact card)", () => {
  it("opens collapsed, showing the header and summary but not the body", async () => {
    await render(<Harness />);

    expect(screen.getByTestId("detail-card")).toBeOnTheScreen();
    expect(screen.getByText("SAS123")).toBeOnTheScreen();
    expect(screen.getByTestId("detail-card-summary")).toHaveTextContent("FL350 · 450 kt");
    expect(screen.queryByTestId("detail-card-body")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("full-details")).not.toBeOnTheScreen();
  });

  it("has an opaque surface on native (no blur there, so translucency would let the scene bleed through)", async () => {
    await render(<Harness />);

    const card = StyleSheet.flatten(screen.getByTestId("detail-card").props.style);
    expect(card.backgroundColor).toBe(color.bg);
    expect(card).not.toHaveProperty("backdropFilter");
  });

  it("expands with the toggle, then collapses again", async () => {
    await render(<Harness />);

    await fireEvent.press(screen.getByTestId("detail-card-toggle"));
    expect(screen.getByTestId("full-details")).toBeOnTheScreen();
    expect(screen.queryByTestId("detail-card-summary")).not.toBeOnTheScreen();
    expect(screen.getByTestId("detail-card-toggle")).toBeExpanded();

    await fireEvent.press(screen.getByTestId("detail-card-toggle"));
    expect(screen.queryByTestId("full-details")).not.toBeOnTheScreen();
  });

  it("closes with the close button", async () => {
    await render(<Harness />);

    await fireEvent.press(screen.getByTestId("detail-card-close"));
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();
  });

  it("closes with Android's hardware back button, and stops listening once closed", async () => {
    const onClosed = jest.fn();
    await render(<Harness onClosed={onClosed} />);

    await pressHardwareBack();
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();
    expect(onClosed).toHaveBeenCalledTimes(1);

    // Closed: back is no longer the card's to handle.
    await pressHardwareBack();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
