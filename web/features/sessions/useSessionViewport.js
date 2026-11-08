import { useEffect } from "react";
import { createViewportVariables } from "./viewport-variables.js";

// One holder count for the whole page: several session views can be on screen at
// once (one per pane), and the variables stay until the last of them unmounts.
let variables = null;
// About a second of frames: long enough for iOS to report the viewport after the app
// returns from the background, short enough to stop on its own.
const settleFrames = 60;
const shared = () =>
  (variables ??= createViewportVariables(document.documentElement.style));

export default function useSessionViewport(active) {
  useEffect(() => {
    if (!active) return;
    const viewport = window.visualViewport;
    // iPadOS may request a desktop layout, including when a trackpad is attached.
    // Keep this query in sync with mobile-workspace.css.
    const media = window.matchMedia("(max-width: 700px), (any-pointer: coarse)");
    const style = document.documentElement.style;
    const release = shared().acquire();
    const clear = () => {
      style.removeProperty("--session-viewport-height");
      style.removeProperty("--session-viewport-top");
    };
    const update = () => {
      if (!media.matches) return clear();
      if (document.hidden) return;
      const height = viewport?.height ?? window.innerHeight;
      if (!Number.isFinite(height) || height <= 0) return;
      style.setProperty("--session-viewport-height", `${height}px`);
      style.setProperty("--session-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    // iOS closes the keyboard while the app is in the background and reports the
    // viewport it had before for a moment after the app returns, without a resize
    // event once the real height arrives. Read it again on the next frames.
    let frame = 0;
    let frames = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frames = settleFrames;
      const next = () => {
        update();
        frame = --frames > 0 ? requestAnimationFrame(next) : 0;
      };
      next();
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("pageshow", settle);
    window.addEventListener("focus", settle);
    document.addEventListener("visibilitychange", settle);
    media.addEventListener("change", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
      window.removeEventListener("pageshow", settle);
      window.removeEventListener("focus", settle);
      document.removeEventListener("visibilitychange", settle);
      media.removeEventListener("change", update);
      release();
    };
  }, [active]);
}
