import useMediaQuery from "../../lib/useMediaQuery.js";
import { mediaQueries } from "../../lib/breakpoints.js";

/** Whether split views are offered: only wider than 1150 px. */
export default function useViewsOffered() {
  return useMediaQuery(mediaQueries.aboveTablet);
}
