import useMediaQuery from "./useMediaQuery.js";
import { mediaQueries } from "./breakpoints.js";

// True while the single-column (list first, then detail) layout applies.
export default function useMobileLayout() {
  return useMediaQuery(mediaQueries.phone);
}
