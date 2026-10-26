import React from "react";
import ErrorMessage from "../../../../components/ErrorMessage.jsx";
import { useCrossLink } from "../../../../app/cross-link.js";
import { assistantSettingsCopy } from "../../../../lib/i18n/messages/assistant-settings.js";
import { assistantSshCopy as sshCopy } from "../../../../lib/i18n/messages/assistant-ssh.js";
import { connectionsRoute } from "../../../connections/routes.js";
import { agentRoute, setSshGrant, sshModes } from "../agent-settings-fields.js";
import AccessGroup from "./AccessGroup.jsx";
import GrantRow from "./GrantRow.jsx";
import { addSshGrants, candidatesOf } from "./access-groups.js";

const copy = assistantSettingsCopy.access;
const endpoint = (host) =>
  [
    host.type === "sftp" ? sshCopy.sftp : "",
    sshCopy.endpoint(host.username, host.host, host.port),
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * SSH/SFTP: the hosts this agent may use, each with its mode (Mit Freigabe, Vertraut,
 * Vertraut inkl. Routinen). `hosts` is undefined while loading and null when the
 * catalog could not be read; grants of removed hosts are listed to drop on save.
 */
export default function SshAccess({ assistantId, hosts, draft, disabled, go, navigate }) {
  const crossLink = useCrossLink();
  const grants = draft.values.sshAccesses;
  const known = hosts || [];
  const hostOf = new Map(known.map((h) => [h.id, h]));
  const entries = grants.map((grant) => ({
    id: grant.accessId,
    mode: grant.mode,
    host: hostOf.get(grant.accessId) || null,
  }));
  const shownEntries = hosts ? entries : [];
  const set = (next) => draft.set("sshAccesses", next);
  const modeOptions = sshModes.map((value) => ({ value, label: sshCopy.modes[value] }));
  const trusted = shownEntries.some((entry) => entry.host && entry.mode !== "approval");
  return (
    <AccessGroup
      id="agent-access-ssh"
      title={copy.ssh}
      hint={sshCopy.intro}
      entries={shownEntries}
      total={hosts ? hosts.length : null}
      loading={hosts === undefined}
      more={{
        route: agentRoute(assistantId, "access", "ssh"),
        open: () => go("access", "ssh"),
      }}
      renderRow={(entry) =>
        entry.host ? (
          <GrantRow
            key={entry.id}
            id={entry.id}
            name={entry.host.name}
            sub={[endpoint(entry.host), entry.host.projectName || ""]
              .filter(Boolean)
              .join(" · ")}
            disabled={disabled}
            mode={{
              label: copy.modeLabel(entry.host.name),
              value: entry.mode,
              options: modeOptions,
              onChange: (mode) => set(setSshGrant(grants, entry.id, mode)),
            }}
            onRevoke={() => set(setSshGrant(grants, entry.id, null))}
          />
        ) : (
          <GrantRow
            key={entry.id}
            id={entry.id}
            name={sshCopy.removed}
            sub={sshCopy.removedHint}
            disabled={disabled}
            onRevoke={() => set(setSshGrant(grants, entry.id, null))}
          />
        )
      }
      picker={{
        typeLabel: copy.sshType,
        candidates: candidatesOf(known, (host) => ({
          sub: endpoint(host),
          group: host.projectName || undefined,
        })),
        granted: grants.map((grant) => grant.accessId),
        modes: modeOptions,
        defaultMode: "approval",
        disabled,
        onAdd: (items, mode) =>
          set(
            addSshGrants(
              grants,
              items.map((item) => item.id),
              mode,
            ),
          ),
      }}
      setup={{
        title: sshCopy.manage,
        route: crossLink(connectionsRoute("ssh")),
        navigate,
      }}
      notes={
        <>
          {hosts === null && <ErrorMessage error={sshCopy.loadError} />}
          {trusted && <p className="ssh-grant-warning">{sshCopy.trustedWarning}</p>}
        </>
      }
    />
  );
}
