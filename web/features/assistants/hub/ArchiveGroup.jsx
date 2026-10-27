import React, { useId, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantBrowserCopy } from "../../../lib/i18n/messages/assistant-browser.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { agentLifecycleCopy as lifecycleCopy } from "../../../lib/i18n/messages/agent-lifecycle.js";
import { AgentDeleteDialog } from "../settings/AgentLifecycleDialogs.jsx";
import { assistantApi } from "../assistant-api.js";
import { avatarGlyph } from "../avatar-glyph.js";
import useAssistants from "../useAssistants.js";
import { settingsRoute } from "./AgentRow.jsx";

/**
 * Alle Agenten › Archiv: archived agents and team members behind one row. Every
 * archived agent is restored, may reset its browser profile (as its settings offer),
 * opens its settings and is deleted permanently after its confirmation. A delete that
 * did not finish shows as pending, with its last failure, and can be retried.
 */
export default function ArchiveGroup({ archived, navigate }) {
  const { members = [], assistants = [], deletions = [], refresh } = useAssistants();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resetting, setResetting] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const id = useId();
  if (!archived.length && !deletions.length) return null;
  const memberOf = (a) => members.find((m) => m.assistantId === a.id) || null;
  const leadName = (member) =>
    assistants.find((x) => x.id === member?.parentAssistantId)?.name ||
    member?.parentName ||
    "";
  const run = async (operation, done) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      if (done) setNotice(done);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id}>{copy.archive}</GroupLabel>
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.archiveRow}
          sub={copy.archiveSub}
          value={archived.length + deletions.length}
        >
          <button
            type="button"
            className="button secondary compact"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            onClick={() => setOpen(!open)}
          >
            {open ? copy.hideArchive : copy.showArchive}
          </button>
        </ListRow>
        <div id={`${id}-list`} className="agents-hub-archive" hidden={!open}>
          {open &&
            archived.map((a) => {
              const member = memberOf(a);
              const settings = settingsRoute(a.id);
              return (
                <ListRow
                  key={a.id}
                  icon={<span className="assistant-avatar">{avatarGlyph(a.name)}</span>}
                  label={a.name}
                  sub={
                    member ? copy.archivedMember(leadName(member)) : copy.archivedAgent
                  }
                >
                  <div className="agents-hub-row-actions">
                    <button
                      type="button"
                      className="button secondary compact"
                      disabled={busy}
                      onClick={() =>
                        run(() => assistantApi.restoreAgent(a.id, a.revision))
                      }
                    >
                      {copy.restore}
                    </button>
                    <button
                      type="button"
                      className="button secondary compact"
                      disabled={busy}
                      onClick={() => setResetting(a)}
                    >
                      {assistantBrowserCopy.reset}
                    </button>
                    <a
                      className="button secondary compact"
                      href={routePath(settings)}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(settings);
                      }}
                    >
                      {assistantCopy.settings}
                    </a>
                    <button
                      type="button"
                      className="button destructive compact"
                      disabled={busy}
                      onClick={() => setDeleting(a)}
                    >
                      {lifecycleCopy.deletePermanently}
                    </button>
                  </div>
                </ListRow>
              );
            })}
          {open &&
            deletions.map((d) => (
              <ListRow
                key={d.id}
                icon={<span className="assistant-avatar">{avatarGlyph(d.name)}</span>}
                label={d.name}
                sub={
                  d.error
                    ? lifecycleCopy.deletionFailed(d.error)
                    : lifecycleCopy.deletionPending
                }
              >
                <div className="agents-hub-row-actions">
                  <button
                    type="button"
                    className="button destructive compact"
                    disabled={busy}
                    onClick={() => setDeleting(d)}
                  >
                    {lifecycleCopy.deletePermanently}
                  </button>
                </div>
              </ListRow>
            ))}
        </div>
      </ListCard>
      <ErrorMessage error={error} />
      {notice && (
        <p role="status" className="assistant-notice">
          {notice}
        </p>
      )}
      {resetting && (
        <ConfirmDialog
          destructive
          title={assistantBrowserCopy.resetTitle}
          body={assistantBrowserCopy.resetDescription}
          confirmLabel={assistantBrowserCopy.resetConfirm}
          onCancel={() => setResetting(null)}
          onConfirm={() => {
            const target = resetting;
            setResetting(null);
            return run(
              () => assistantApi.browserReset(target.id),
              assistantBrowserCopy.resetDone,
            );
          }}
        />
      )}
      {deleting && (
        <AgentDeleteDialog
          assistant={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
