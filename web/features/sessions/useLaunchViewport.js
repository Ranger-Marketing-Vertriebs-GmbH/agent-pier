import { useEffect, useState } from "react";

// The visual viewport shrinks when a mobile keyboard covers the layout viewport.
export default function useLaunchViewport() {
  const [style, setStyle] = useState({});
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    function update() {
      // Preserve native pinch zoom rather than resizing the dialog into it.
      setStyle(
        viewport.scale === 1
          ? {
              "--launch-height": `${viewport.height}px`,
              "--launch-top": `${viewport.offsetTop}px`,
            }
          : {},
      );
    }
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return style;
}
