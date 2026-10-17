import React from "react";
import { names } from "../../lib/providers.js";
import { toolInstallerCopy as copy } from "../../lib/i18n/messages/tools.js";

/**
 * The selected CLI's version state in the launch dialog. Below its minimum the
 * server refuses the launch of an installation AgentPier manages, so the notice
 * offers the existing update dialog; an external installation and an unreadable
 * version only warn. `refused` is the server's update_required detail
 * when the launch was refused with a newer state than the tool list shows.
 */
export default function CliVersionNotice({ tool, refused, update }) {
  if (!tool) return null;
  const name = names[tool.id] || tool.name;
  const outdated =
    refused?.tool === tool.id
      ? refused
      : tool.versionStatus === "update-required"
        ? { found: tool.version, required: tool.minimumVersion }
        : null;
  // AgentPier cannot update an installation it does not manage, so the server
  // starts it anyway and the notice names the way out instead of a failing button.
  if (outdated && refused?.tool !== tool.id && tool.managedInstall === false)
    return (
      <div className="cli-version-notice update-required" role="status">
        <p>{copy.externalUpdateNotice(name, outdated.found, outdated.required)}</p>
      </div>
    );
  if (outdated)
    return (
      <div className="cli-version-notice update-required" role="status">
        <p>{copy.updateRequiredNotice(name, outdated.found, outdated.required)}</p>
        {update && (
          <button
            type="button"
            className="button secondary compact"
            onClick={() => update(tool.id)}
          >
            {copy.updateTitle(name)}
          </button>
        )}
      </div>
    );
  if (tool.versionStatus === "unknown")
    return (
      <div className="cli-version-notice" role="status">
        <p>{copy.versionUnknownNotice(name)}</p>
      </div>
    );
  return null;
}
