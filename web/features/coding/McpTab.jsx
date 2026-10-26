import React, { lazy, Suspense } from "react";
import useReturnTarget from "../../app/useReturnTarget.js";
import { codingPageCopy as copy } from "../../lib/i18n/messages/coding.js";
import CodingFrame from "./CodingFrame.jsx";

const McpSettings = lazy(() => import("../mcp/McpSettings.jsx"));

/**
 * AgentPier als MCP: connect a coding CLI, the consent screen of a CLI's sign-in
 * (`authorization`, also from the server's /settings/mcp?authorization=… link) and
 * the connected clients with revoke and paging.
 */
export default function McpTab({ frame, route, onNavigate }) {
  const returnTarget = useReturnTarget(route, onNavigate);
  return (
    <CodingFrame
      {...frame}
      className="coding-mcp"
      leading={returnTarget ? "back" : "menu"}
      leadingLabel={returnTarget?.label}
      onLeading={returnTarget ? returnTarget.back : frame.onLeading}
    >
      <Suspense
        fallback={
          <p className="loading" role="status">
            {copy.loading}
          </p>
        }
      >
        <McpSettings
          route={route}
          navigate={(changes, replace = false) =>
            onNavigate({ ...route, ...changes }, replace)
          }
        />
      </Suspense>
    </CodingFrame>
  );
}
