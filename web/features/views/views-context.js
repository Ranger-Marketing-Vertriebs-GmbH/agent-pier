import { createContext, useContext } from "react";

// The owner's split views for the sidebar, the view pages and the click rule.
export const ViewsContext = createContext(null);

export const useViews = () => useContext(ViewsContext);
