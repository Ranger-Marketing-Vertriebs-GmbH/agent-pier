import { createContext, createElement, useContext } from "react";
import useViewsStore from "./useViewsStore.js";

// The owner's split views for the sidebar, the view pages and the click rule.
export const ViewsContext = createContext(null);

export function ViewsProvider({ enabled, children }) {
  const store = useViewsStore({ enabled });
  return createElement(ViewsContext.Provider, { value: store }, children);
}

export const useViews = () => useContext(ViewsContext);
