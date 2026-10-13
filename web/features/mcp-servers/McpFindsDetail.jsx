import React from "react";
import McpCliFinds from "./McpCliFinds.jsx";
import "./mcp-servers.css";
import "./mcp-cli.css";

// The finds bring their own region and heading ("In den CLIs gefunden"); a second
// frame heading would duplicate the region name.
export default function McpFindsDetail({ data }) {
  return (
    <div className="accounts-detail accounts-finds">
      <McpCliFinds refresh={data.mcpGeneration} onAdopted={data.reloadMcp} />
    </div>
  );
}
