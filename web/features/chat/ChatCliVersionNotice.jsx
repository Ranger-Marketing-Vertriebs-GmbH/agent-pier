import React from "react";
import CopyButton from "../../components/CopyButton.jsx";
import { names } from "../../lib/providers.js";
import { chatCliVersionCopy as copy } from "../../lib/i18n/messages/chat.js";
import { toolInstallerCopy } from "../../lib/i18n/messages/tools.js";
import { outdatedCli } from "./cli-version-notice.js";

/**
 * A running session whose CLI is older than AgentPier supports (cli-version-notice.js):
 * what may not work and how to update it for the way it was installed. It follows
 * the workspace state, so it goes as soon as the installed CLI is current again.
 * `update(toolId)` opens AgentPier's update dialog for an installation it manages.
 */
export default function ChatCliVersionNotice({ session, tool, update }) {
  const outdated = outdatedCli(session, tool);
  if (!outdated) return null;
  const name = names[outdated.tool] || tool.name || outdated.tool;
  return (
    <div
      className="chat-limit-warnings chat-cli-version-notice"
      role="status"
      aria-label={copy.title}
    >
      <strong>{copy.title}</strong>
      <p>{copy.outdated(name, outdated.found, outdated.required)}</p>
      {outdated.method === "managed" && update && (
        <div className="chat-limit-actions">
          <button
            type="button"
            className="button secondary compact"
            onClick={() => update(outdated.tool)}
          >
            {toolInstallerCopy.updateTitle(name)}
          </button>
        </div>
      )}
      {outdated.command && (
        <>
          <p>{copy[outdated.method]}</p>
          <div className="chat-limit-actions">
            <code>{outdated.command}</code>
            <CopyButton
              text={outdated.command}
              label={copy.copyCommand}
              className="button secondary compact"
            />
          </div>
        </>
      )}
      {outdated.method === "unknown" && <p>{copy.unknown}</p>}
      <p>{copy.reload}</p>
    </div>
  );
}
