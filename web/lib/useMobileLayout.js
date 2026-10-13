import { useEffect, useState } from "react";

const mobileQuery = "(max-width: 700px)";

// True while the single-column (list first, then detail) layout applies.
export default function useMobileLayout() {
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    // The window may have crossed the breakpoint between the first render and this
    // subscription; that change event went to nobody, so read the current state once.
    change();
    return () => media.removeEventListener("change", change);
  }, []);
  return mobile;
}
