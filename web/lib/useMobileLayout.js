import useMediaQuery from "./useMediaQuery.js";

// True while the single-column (list first, then detail) layout applies.
export default function useMobileLayout() {
  return useMediaQuery("(max-width: 700px)");
}
