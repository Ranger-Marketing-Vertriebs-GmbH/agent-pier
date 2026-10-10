import { useEffect, useState } from "react";

// True while the primary pointer is coarse; follows pointer changes (for example a
// trackpad attached to a tablet).
export default function useTouchInput() {
  const [touchInput, setTouchInput] = useState(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setTouchInput(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return touchInput;
}
