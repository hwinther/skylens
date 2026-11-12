/**
 * First-run onboarding. What it leaves behind matters more than how it looks: the persisted
 * `onboarded` flag (so the intro never shows again) and `demoMode` (demo by default; live only when
 * the user chose "Go live"), plus the camera permission request riding the "Go live" tap.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { useCameraPermissions } from "expo-camera";
import OnboardingScreen from "../../app/onboarding";
import { useSettingsStore } from "@/state/settingsStore";
import { resetStores } from "./fixtures";

const settings = () => useSettingsStore.getState();

describe("OnboardingScreen", () => {
  let requestCamera: jest.Mock;

  beforeEach(() => {
    resetStores();
    useSettingsStore.setState({ onboarded: false, demoMode: true });
    requestCamera = jest.fn(() => Promise.resolve({ granted: true }));
    jest
      .mocked(useCameraPermissions)
      .mockReturnValue([null, requestCamera, jest.fn()] as unknown as ReturnType<
        typeof useCameraPermissions
      >);
  });

  it("Skip finishes in demo mode and never shows the intro again", async () => {
    useSettingsStore.setState({ demoMode: false });
    await render(<OnboardingScreen />);

    await fireEvent.press(screen.getByTestId("onboarding-skip"));

    expect(settings().onboarded).toBe(true);
    expect(settings().demoMode).toBe(true);
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(requestCamera).not.toHaveBeenCalled();
  });

  it("Go live asks for the camera on the tap and finishes in live mode", async () => {
    await render(<OnboardingScreen />);

    await fireEvent.press(screen.getByText("Go live"));
    expect(requestCamera).toHaveBeenCalledTimes(1);
    expect(settings().demoMode).toBe(false);
    // Not finished until the user has been through the steps.
    expect(settings().onboarded).toBe(false);

    await fireEvent.press(screen.getByText("Next"));
    await fireEvent.press(screen.getByText("Start"));

    expect(settings().onboarded).toBe(true);
    expect(settings().demoMode).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("still moves on when the camera request fails", async () => {
    requestCamera.mockRejectedValue(new Error("no camera"));
    await render(<OnboardingScreen />);

    await fireEvent.press(screen.getByText("Go live"));

    expect(screen.getByText("Next")).toBeOnTheScreen();
    expect(settings().demoMode).toBe(false);
  });

  it("Explore in demo first finishes in demo mode without asking for the camera", async () => {
    useSettingsStore.setState({ demoMode: false });
    await render(<OnboardingScreen />);

    await fireEvent.press(screen.getByText("Explore in demo first"));
    await fireEvent.press(screen.getByText("Next"));
    await fireEvent.press(screen.getByText("Start"));

    expect(settings().onboarded).toBe(true);
    expect(settings().demoMode).toBe(true);
    expect(requestCamera).not.toHaveBeenCalled();
  });
});
