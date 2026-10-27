import React from "react";

const route = { view: "coding", codingTab: "install" };

/**
 * A link to the card of an AgentPier-managed tool (Coding › CLIs, install tab). A real
 * link (copyable, middle-clickable) that navigates inside the app on a plain click.
 */
export default function ManagedToolLink({ navigate, children }) {
  return (
    <a
      href="/coding/clis?tab=install"
      onClick={(event) => {
        if (
          !navigate ||
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
