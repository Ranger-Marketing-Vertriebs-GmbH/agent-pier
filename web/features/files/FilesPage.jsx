import React from "react";
import ExplorerWorkspace from "./ExplorerWorkspace.jsx";

export default function FilesPage({ route, navigate }) {
  return (
    <ExplorerWorkspace scopeRef={{ kind: "global" }} route={route} navigate={navigate} />
  );
}
