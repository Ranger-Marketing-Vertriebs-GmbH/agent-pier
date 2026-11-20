import React from "react";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import { useAppNavigate, useCrossLink } from "../../app/cross-link.js";

/** The provider connection page, opened at one model row's context field. */
export const modelContextRoute = (connectionId, modelId) => ({
  view: "connections",
  section: "models",
  item: connectionId,
  model: modelId,
});

/**
 * An inline link straight to the context field of a model that needs one. Inside the
 * app it navigates in place (closing the launcher); elsewhere it loads the address.
 */
export default function ModelContextLink({ connectionId, modelId, children }) {
  const navigate = useAppNavigate();
  const target = useCrossLink()(modelContextRoute(connectionId, modelId));
  return (
    <a
      href={routePath(target)}
      onClick={(event) => {
        if (!navigate || !isPlainClick(event)) return;
        event.preventDefault();
        navigate(target);
      }}
    >
      {children}
    </a>
  );
}
