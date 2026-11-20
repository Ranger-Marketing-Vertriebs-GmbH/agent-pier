import { createContext, useContext } from "react";
import { crossLinkRoute } from "./routes.js";

// The route on screen, provided once by the app. A link into another area wraps its
// target with `useCrossLink()` so the target page's back arrow returns here.
export const CrossLinkOrigin = createContext(null);

export function useCrossLink() {
  const origin = useContext(CrossLinkOrigin);
  return (target) => crossLinkRoute(target, origin);
}

// The app's navigate function, for links in places that get no `navigate` prop (the
// session launcher, model pickers). Null outside the app: links then load the page.
export const AppNavigate = createContext(null);

export const useAppNavigate = () => useContext(AppNavigate);
