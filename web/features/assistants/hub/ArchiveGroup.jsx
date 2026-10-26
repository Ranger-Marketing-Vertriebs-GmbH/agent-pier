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
import { assistantApi } from "../assistant-api.js";
import { avatarGlyph } from "../avatar-glyph.js";
import useAssistants from "../useAssistants.js";
import { settingsRoute } from "./AgentRow.jsx";

/**
 * Alle Agenten › Archiv: archived agents and team members behind one row. A member
 * is restored through its team endpoint; every archived agent may reset its browser
 * profile (as its settings offer) and opens its settings.
 */
export default function ArchiveGroup({ archived, navigate }) {
  const { members = [], assistants = [], refresh } = useAssistants();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resetting, setResetting] = useState(null);
  const id = useId();
  if (!archived.length) return null;
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
        <ListRow label={copy.archiveRow} sub={copy.archiveSub} value={archived.length}>
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
                    {member && (
                      <button
                        type="button"
                        className="button secondary compact"
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            assistantApi.teamAction(
                              "team-members",
                              member.id,
                              "restore",
                              member.revision,
                            ),
                          )
                        }
                      >
                        {copy.restore}
                      </button>
                    )}
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
                  </div>
                </ListRow>
              );
            })}
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
    </section>
  );
}
