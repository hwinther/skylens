/**
 * Web-only rear-camera preview for mobile-browser AR.
 *
 * Opens the environment-facing camera via getUserMedia and paints it into a raw,
 * absolutely-positioned <video> that fills the screen (object-fit: cover) behind the AR
 * overlay — the web analogue of native's expo-camera CameraView. Raw DOM JSX is fine
 * here because Metro only bundles this `.web.tsx` on web; native gets the null sibling.
 *
 * Denied/unsupported cameras call onStatus("denied") and render an (empty) element
 * instead of throwing, so the caller can fall back to the synthetic horizon. All tracks
 * are stopped on unmount and whenever `active` flips false, so the camera light goes off.
 */

import { useEffect, useRef } from "react";

export interface WebCameraViewProps {
  /** Start the camera when true; stop and release tracks when false. */
  active: boolean;
  /** Camera lifecycle callback: "on" once streaming, "off" on teardown, "denied" on failure. */
  onStatus?: (status: "on" | "off" | "denied") => void;
}

export function WebCameraView({ active, onStatus }: WebCameraViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Latest onStatus in a ref so the effect isn't torn down/re-run when the callback identity changes.
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const releaseTracks = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    void (async () => {
      try {
        const stream = await navigator.mediaDevices?.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (!stream) {
          onStatusRef.current?.("denied");
          return;
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          void video.play().catch(() => {}); // autoplay can reject; the muted attr usually covers it
        }
        onStatusRef.current?.("on");
      } catch {
        if (!cancelled) onStatusRef.current?.("denied");
      }
    })();

    return () => {
      cancelled = true;
      releaseTracks();
      onStatusRef.current?.("off");
    };
  }, [active]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
      }}
    />
  );
}
