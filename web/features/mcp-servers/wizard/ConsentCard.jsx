import React from "react";
import { routePath } from "../../../app/routes.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { shellLevel } from "../../assistants/shell-level.js";

const writeLine = (write) =>
  !write
    ? copy.connect.writeNone
    : write.state === "off"
      ? copy.connect.writeOff(write.name)
      : write.state === "on"
        ? copy.connect.writeOn(write.name)
        : copy.connect.writeStored(write.name);

/**
 * "What this allows": the single consent of Connect. It names the local-command
 * rights (stdio), the server's own write switch and that shell access is separate,
 * with each chosen agent's shell level. It describes the primary button.
 */
export default function ConsentCard({ id, stdio, write, agents, navigate }) {
  return (
    <section id={id} className="mcp-consent" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mcp-wizard-subtitle">
        {copy.connect.allows}
      </h2>
      <ul>
        {stdio && <li>{copy.connect.stdioRights}</li>}
        <li>{writeLine(write)}</li>
        <li>
          {copy.connect.shellSeparate}
          {agents.length > 0 && (
            <ul>
              {agents.map((item) => {
                const route = {
                  view: "agents",
                  assistantId: item.id,
                  agentSettings: true,
                  agentTab: "capabilities",
                };
                return (
                  <li key={item.id}>
                    {copy.connect.agentShell(
                      item.name,
                      assistantShellCopy.levels[shellLevel(item)],
                    )}{" "}
                    <a
                      href={routePath(route)}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(route);
                      }}
                    >
                      {copy.connect.agentSettings(item.name)}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      </ul>
    </section>
  );
}
