import { useEffect, useState } from "react";

const mobileQuery = "(max-width: 700px)";

// True while the single-column (list first, then detail) layout applies.
export default function useMobileLayout() {
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    // A fresh query: during a resize event WebKit still reports the old result
    // through an existing MediaQueryList.
    const change = () => setMobile(window.matchMedia(mobileQuery).matches);
    media.addEventListener("change", change);
    // WebKit can drop the change event when the viewport crosses the breakpoint, which
    // left the sidebar inert on desktop. Every resize re-reads the query as well.
    window.addEventListener("resize", change);
    // The window may have crossed the breakpoint between the first render and this
    // subscription; that change event went to nobody, so read the current state once.
    change();
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("resize", change);
    };
  }, []);
  return mobile;
}
