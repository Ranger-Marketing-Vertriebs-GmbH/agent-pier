import React from "react";
import ExplorerWorkspace from "./ExplorerWorkspace.jsx";

export default function FileExplorer({ session, route, navigate }) {
  return (
    <ExplorerWorkspace
      scopeRef={{
        kind: "project",
        sessionId: session.id,
        contextKey: `${session.cwd}:${session.pipeline?.headless === true}`,
      }}
      route={route}
      navigate={navigate}
    />
  );
}
