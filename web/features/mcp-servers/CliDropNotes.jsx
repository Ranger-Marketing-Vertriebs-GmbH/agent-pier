import React from "react";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";
import { cliSupport, clis } from "./cli-support.js";

/** A bound CLI the edited definition rules out: saving removes the server there. */
export default function CliDropNotes({ values, server }) {
  const target = { transport: values.transport, cwd: values.cwd.trim() };
  const dropped = clis.filter(
    (cli) => (server.clis || []).includes(cli) && !cliSupport(cli, target).supported,
  );
  return (
    <div className="mcp-cli-notes" aria-live="polite">
      {dropped.map((cli) => (
        <p key={cli} className="mcp-hint mcp-cli-note">
          {copy.removedOnSave(names[cli], server.name)}
        </p>
      ))}
    </div>
  );
}
