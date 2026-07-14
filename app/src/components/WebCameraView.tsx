/**
 * Native (and default) sibling of WebCameraView.web.tsx — renders nothing.
 *
 * Native already has the real camera via expo-camera's CameraView (see app/index.tsx);
 * the getUserMedia-based preview only exists for the web build. This stub keeps the DOM
 * <video> path out of the native (Hermes) bundle while letting app/index.tsx import the
 * component by a bare path on every platform. Keep the props identical to the .web.tsx.
 */

export interface WebCameraViewProps {
  /** Start the camera when true; stop and release tracks when false. */
  active: boolean;
  /** Camera lifecycle callback (unused on native). */
  onStatus?: (status: "on" | "off" | "denied") => void;
}

export function WebCameraView(_props: WebCameraViewProps): null {
  return null;
}
