import React from "react";
import { routePath } from "../../app/routes.js";
// A real link (copyable, middle-clickable) that navigates inside the app on a plain click.
export default function RouteLink({ route, navigate, children, ...props }) {
  return (
    <a
      {...props}
      href={routePath(route)}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(route);
      }}
    >
      {children}
    </a>
  );
}
