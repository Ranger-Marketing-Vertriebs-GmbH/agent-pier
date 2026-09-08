import { useEffect } from "react";

export default function useChatViewport(active) {
  useEffect(() => {
    if (!active) return;
    const viewport = window.visualViewport;
    const media = window.matchMedia("(max-width: 700px)");
    const style = document.documentElement.style;
    const clear = () => {
      style.removeProperty("--chat-viewport-height");
      style.removeProperty("--chat-viewport-top");
    };
    const update = () => {
      if (!media.matches) return clear();
      if (document.hidden) return;
      const height = viewport?.height ?? window.innerHeight;
      if (!Number.isFinite(height) || height <= 0) return;
      style.setProperty("--chat-viewport-height", `${height}px`);
      style.setProperty("--chat-viewport-top", `${viewport?.offsetTop ?? 0}px`);
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
      clear();
    };
  }, [active]);
}
