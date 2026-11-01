import { usePane } from "./pane-context.js";
import useMediaQuery from "./useMediaQuery.js";

// Whether a view is narrow: inside a pane its own width decides, else the window's
// media query. Both checks run so the hooks keep their order.
export default function useNarrow(query, maxWidth) {
  const pane = usePane();
  const matches = useMediaQuery(query);
  return pane ? pane.width <= maxWidth : matches;
}
