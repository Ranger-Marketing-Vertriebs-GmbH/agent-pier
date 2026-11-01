import { useEffect } from "react";
import { createViewportVariables } from "./viewport-variables.js";

// One holder count for the whole page: several session views can be on screen at
// once (one per pane), and the variables stay until the last of them unmounts.
let variables = null;
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
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("pageshow", update);
    document.addEventListener("visibilitychange", update);
    media.addEventListener("change", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("pageshow", update);
      document.removeEventListener("visibilitychange", update);
      media.removeEventListener("change", update);
      release();
    };
  }, [active]);
}
