import React, { useId } from "react";
import { mcpDirectoryCopy as copy } from "../../../lib/i18n/messages/mcp-directory.js";
import { curatedHintFor } from "./curated-hints.js";

/**
 * AgentPier's own note on a known MCP server (curated-hints.js), shown in the
 * directory detail and on the package step. Renders nothing for any other server.
 */
export default function CuratedHint({ serverName, registry, packageName, level = 3 }) {
  const id = useId();
  const key = curatedHintFor({ serverName, registry, packageName });
  const hint = key ? copy.curated.hints[key] : null;
  if (!hint) return null;
  const Heading = `h${level}`;
  return (
    <section className="mcp-wizard-notice mcp-curated-hint" aria-labelledby={id}>
      <Heading id={id} className="mcp-wizard-subtitle">
        {hint.title}
      </Heading>
      <p className="mcp-hint">{copy.curated.label}</p>
      <ul className="mcp-curated-points">
        {hint.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </section>
  );
}
