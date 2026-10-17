import React from "react";
import { routePath } from "../../../app/routes.js";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import useBrowserStream from "./useBrowserStream.js";
import "./agent-browser.css";

/** A small live picture of the agent's running browser; opens the full view. */
export default function BrowserPreview({ assistant, navigate }) {
  const { image } = useBrowserStream(assistant.id, { preview: true });
  const route = { view: "agents", assistantId: assistant.id, agentBrowser: true };
  return (
    <a
      className="agent-browser-preview"
      href={routePath(route)}
      aria-label={copy.livePreview(assistant.name)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
          return;
        event.preventDefault();
        navigate(route);
      }}
    >
      {image ? <img src={image} alt="" /> : <span>{copy.running}</span>}
    </a>
  );
}
