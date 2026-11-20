import React, { useMemo } from "react";
import Icon from "../../../components/Icon.jsx";
import RouteLink from "../RouteLink.jsx";
import { browserOffered, browserRoute, takeoverHref } from "./browser-entry.js";
import { takeoverUrl } from "./takeover-link.js";

/**
 * The `takeover` of an agent chat: its agent's take-over link opens the browser
 * taking control, on the owner's own agents, which are told to write it
 * (assistant-bootstrap.js); null elsewhere.
 */
export function useTakeoverLink(assistant, navigate) {
  const offered = browserOffered(assistant) && !assistant.userAccess;
  const id = assistant?.id;
  return useMemo(
    () => (offered ? { assistantId: id, navigate } : null),
    [offered, id, navigate],
  );
}

/**
 * The markdown props for an agent's message (AssistantMessage.jsx): its take-over link
 * becomes a button to its browser page taking control (`takeover`:
 * `{ assistantId, navigate }`); without one (another chat) it is plain text.
 */
export function takeoverMarkdown(takeover) {
  return {
    urlTransform: takeoverUrl,
    components: {
      a: ({ node: _node, href, children, ...props }) =>
        href !== takeoverHref ? (
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ) : takeover ? (
          <RouteLink
            className="button secondary compact assistant-takeover-link"
            route={browserRoute(takeover.assistantId, { takeover: true })}
            navigate={takeover.navigate}
          >
            <Icon name="globe" size={14} />
            {children}
          </RouteLink>
        ) : (
          <span>{children}</span>
        ),
    },
  };
}
