import React from "react";
import { routePath } from "../../app/routes.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import SshAccessDetails from "../ssh/SshAccessDetails.jsx";
import SshDetails from "../ssh/SshDetails.jsx";
import ConnectionUsedBy from "./ConnectionUsedBy.jsx";
import SshHostKeyChanged from "./SshHostKeyChanged.jsx";
import SshTestBox from "./SshTestBox.jsx";
import { sshStatus } from "./connection-items.js";
import { connectionsRoute } from "./routes.js";

/**
 * The detail pane beside the SSH list: the access's facts and actions (edit, test,
 * key, host fingerprint, delete), a failed test with the server's message, "Benutzt
 * von" with grant, mode and revoke, and the way into the full view.
 */
export default function SshDetailPane({
  access,
  catalog,
  usage,
  agentsEnabled,
  assistants,
  navigate,
  reloadUsage,
  close,
  edit,
  viewKey,
  removed,
}) {
  const status = sshStatus(access);
  const full = connectionsRoute("ssh", access.id);
  return (
    <SshDetails close={close}>
      <p className="connections-eyebrow">
        {access.type === "sftp" ? copy.sftpKind : copy.sshKind}
      </p>
      <SshAccessDetails
        key={access.id}
        access={access}
        project={catalog.projectFor(access)}
        edited={edit}
        loading={!catalog.ready}
        viewKey={viewKey}
        removed={removed}
        onTested={() => catalog.reloadAccesses()}
      />
      {status === "hostKey" && (
        <SshHostKeyChanged access={access} onAccepted={() => catalog.reloadAccesses()} />
      )}
      {status === "failed" && (
        <SshTestBox
          access={access}
          affected={[...new Set((usage?.agents || []).map((agent) => agent.name))]}
          onTested={() => catalog.reloadAccesses()}
          onEdit={() => edit(access)}
        />
      )}
      <ConnectionUsedBy
        kind="ssh"
        item={access}
        usage={usage}
        agentsEnabled={agentsEnabled}
        assistants={assistants}
        navigate={navigate}
        onChanged={reloadUsage}
      />
      <a
        className="button secondary connections-full-link"
        href={routePath(full)}
        onClick={(event) => {
          event.preventDefault();
          navigate(full);
        }}
      >
        {copy.fullView}
      </a>
    </SshDetails>
  );
}
