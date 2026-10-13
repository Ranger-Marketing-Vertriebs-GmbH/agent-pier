import { useEffect } from "react";
import { itemRoute } from "./accounts-items.js";

/** After a create, show the new entry in place of the empty form (Back skips it). */
export default function useCreatedRedirect({ created, draft, navigate, section }) {
  useEffect(() => {
    if (created && !draft.dirty) navigate(itemRoute(section, created), true);
  }, [created, draft.dirty, navigate, section]);
}
