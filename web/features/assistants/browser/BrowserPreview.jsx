import React from "react";
import { routePath } from "../../../app/routes.js";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import useBrowserStream from "./useBrowserStream.js";
import "./agent-browser.css";

const plainClick = (event) =>
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0);

/**
 * A small live picture of the agent's running browser that opens the full view, and
 * "Take over", which opens it taking control (for a sign-in or a check).
 */
export default function BrowserPreview({ assistant, navigate }) {
  const { image } = useBrowserStream(assistant.id, { preview: true });
  const route = { view: "agents", assistantId: assistant.id, agentBrowser: true };
  const takeover = { ...route, takeover: true };
  const open = (target) => (event) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    navigate(target);
  };
  return (
    <span className="agent-browser-preview-group">
      <a
        className="agent-browser-preview"
        href={routePath(route)}
        aria-label={copy.livePreview(assistant.name)}
        onClick={open(route)}
      >
        {image ? <img src={image} alt="" /> : <span>{copy.running}</span>}
      </a>
      <a
        className="agent-browser-preview-takeover"
        href={routePath(takeover)}
        onClick={open(takeover)}
      >
        {copy.liveTakeOver}
      </a>
    </span>
  );
}
