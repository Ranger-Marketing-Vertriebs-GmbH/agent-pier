import useMediaQuery from "../../lib/useMediaQuery.js";

/** Phones show the hub and an entry's subpage one at a time. */
export default function useNarrowViewport() {
  return useMediaQuery("(max-width: 700px)");
}
