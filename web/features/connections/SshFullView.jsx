import React, { useId, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { routePath } from "../../app/routes.js";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { sshCopy } from "../../lib/i18n/messages/ssh.js";
import SshAccessForm from "../ssh/SshAccessForm.jsx";
import SshCopy from "../ssh/SshCopy.jsx";
import SshProjectReassign from "../ssh/SshProjectReassign.jsx";
import ConnectionUsedBy from "./ConnectionUsedBy.jsx";
import SshHostKeyChanged from "./SshHostKeyChanged.jsx";
import SshTestBox, { statusTone, testLine } from "./SshTestBox.jsx";
import { sshStatus } from "./connection-items.js";
import { auditRoute } from "./routes.js";

const grantNames = (usage) =>
  [...new Set((usage?.agents || []).map((agent) => agent.name))].filter(Boolean);

/**
 * The full view of an SSH/SFTP access (handoff 5.6, RVollansicht): the complete
 * form with its save bar, the key, "Benutzt von" with granting and revoking, the last
 * test with the server's message (and the host key changed state), and Verwalten.
 */
export default function SshFullView({
  access,
  catalog,
  usage,
  agentsEnabled,
  assistants,
  navigate,
  reloadUsage,
  onDeleted,
}) {
  const id = useId();
  const [deleting, setDeleting] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const status = sshStatus(access);
  const agents = usage?.agents ?? null;
  const hooks = usage?.hooks ?? null;
  const reload = () => {
    catalog.reloadAccesses();
    reloadUsage();
  };
  const audit = auditRoute(access.id);
  const impact =
    agents === null || hooks === null
      ? copy.manage.deleteImpactUnknown
      : copy.manage.deleteImpact(
          new Set(agents.filter((a) => a.via !== "hook").map((a) => a.id)).size,
          hooks.length,
        );
  return (
    <div className="connections-full">
      <div className="connections-full-main">
        <p className="connections-full-status">
          <StatusDot tone={statusTone[status]} />
          <span>{testLine(access)}</span>
        </p>
        {status === "hostKey" && (
          <SshHostKeyChanged
            access={access}
            onAccepted={() => catalog.reloadAccesses()}
          />
        )}
        <section className="connections-section" aria-labelledby={`${id}-form`}>
          <GroupLabel id={`${id}-form`}>{sshCopy.connection}</GroupLabel>
          <div className="connections-form-card">
            <SshAccessForm
              key={`${access.id}:${access.updatedAt || ""}:${access.hostKey}`}
              inline
              access={access}
              keys={catalog.keys}
              projects={catalog.projects}
              saveNote={copy.sshForm.unsaved}
              saved={(result) => {
                catalog.setAccesses((current) => ({
                  accesses: (current?.accesses || []).map((item) =>
                    item.id === result.id ? result : item,
                  ),
                }));
                reloadUsage();
              }}
              close={() => {}}
            />
          </div>
        </section>
        {access.keyId && !access.keyMissing && access.publicKey && (
          <section className="connections-section" aria-labelledby={`${id}-key`}>
            <GroupLabel id={`${id}-key`}>{sshCopy.keyMode}</GroupLabel>
            <div className="connections-form-card">
              <p>{access.keyName}</p>
              <SshCopy
                compact
                label={sshCopy.publicKey}
                text={access.publicKey}
                button={sshCopy.copyKey}
              />
              <p className="ssh-action-hint">{sshCopy.publicKeyHint}</p>
            </div>
          </section>
        )}
        <ConnectionUsedBy
          kind="ssh"
          item={access}
          usage={usage}
          agentsEnabled={agentsEnabled}
          assistants={assistants}
          navigate={navigate}
          onChanged={reloadUsage}
          showPipelines
        />
        <section className="connections-section" aria-labelledby={`${id}-manage`}>
          <GroupLabel id={`${id}-manage`}>{copy.manage.title}</GroupLabel>
          <ListCard labelledBy={`${id}-manage`}>
            <ListRow
              label={copy.manage.activity}
              sub={copy.manage.activityHint}
              value={copy.manage.activityLink}
              href={routePath(audit)}
              onClick={() => navigate(audit)}
            />
            <ListRow
              label={copy.manage.reassign}
              sub={copy.manage.reassignHint}
              chevron={false}
            >
              <button
                type="button"
                className="button secondary compact"
                disabled={
                  !catalog.sourceProjects.some((source) =>
                    catalog.projects.some((target) => target.id !== source?.id),
                  )
                }
                onClick={() => setReassigning(true)}
              >
                {copy.manage.reassignButton}
              </button>
            </ListRow>
            <ListRow label={copy.manage.deleteAccess} sub={impact} chevron={false}>
              <button
                type="button"
                className="button destructive compact"
                onClick={() => setDeleting(true)}
              >
                {commonCopy.delete}
              </button>
            </ListRow>
          </ListCard>
        </section>
      </div>
      <aside className="connections-full-aside">
        <SshTestBox
          access={access}
          affected={grantNames(usage)}
          onTested={() => catalog.reloadAccesses()}
        />
      </aside>
      {deleting && (
        <ConfirmDialog
          destructive
          title={copy.manage.deleteTitle(access.name)}
          body={[
            access.type === "sftp" ? sshCopy.sftpDeleteHint : sshCopy.deleteHint,
            impact,
          ]}
          confirmLabel={sshCopy.confirmDelete}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/ssh-accesses/${encodeURIComponent(access.id)}`, "DELETE");
            setDeleting(false);
            onDeleted(access.id);
          }}
        />
      )}
      {reassigning && (
        <SshProjectReassign
          sourceProjects={catalog.sourceProjects}
          targetProjects={catalog.projects}
          close={() => setReassigning(false)}
          reassigned={() => {
            setReassigning(false);
            catalog.reload();
            reload();
          }}
        />
      )}
    </div>
  );
}
