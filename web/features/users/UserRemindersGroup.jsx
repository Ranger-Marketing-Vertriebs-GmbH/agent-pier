import React, { useCallback, useEffect, useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import RemindersGroup from "../assistants/settings/RemindersGroup.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import { userApi } from "./user-api.js";

// Her reminders through /api/me: no Telegram extra, review or run history there.
const reminderApi = {
  list: (id) => userApi.reminders(id),
  create: (id, input) => userApi.createReminder(id, input),
  update: (id, bindingId, input) => userApi.updateReminder(id, bindingId, input),
  remove: (id, bindingId) => userApi.removeReminder(id, bindingId),
};

/**
 * Her routines on the agent: listed, paused and removed at every level, resumed from
 * Personalize on.
 */
function UserRoutines({ agentId, readOnly }) {
  const personal = assistantCopy.personal;
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await userApi.reminders(agentId, "routines");
      setItems(result.routines || []);
    } catch (e) {
      setError(e.message);
    }
  }, [agentId]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e.message);
    }
    await load();
    setBusy(false);
  };
  return (
    <section aria-labelledby="user-routines">
      <GroupLabel
        id="user-routines"
        hint={readOnly ? copy.routinesChatOnly : copy.routinesHint}
      >
        {copy.routines}
      </GroupLabel>
      <ErrorMessage error={error} />
      <ListCard labelledBy="user-routines">
        {items?.length === 0 && <p className="agent-row-note">{copy.noRoutines}</p>}
        {items?.map((item) => (
          <ListRow
            key={item.id}
            label={item.name || personal.unknownReminder}
            sub={item.enabled ? personal.states.active : personal.states.paused}
            disabled={busy}
            onDelete={() =>
              act(() => userApi.removeReminder(agentId, item.id, "routines"))
            }
            deleteLabel={personal.removeReminder}
          >
            {item.status === "ready" && (!readOnly || item.enabled) && (
              <button
                type="button"
                className="button secondary compact"
                disabled={busy}
                onClick={() =>
                  act(() =>
                    userApi.updateReminder(
                      agentId,
                      item.id,
                      { enabled: !item.enabled, revision: item.revision },
                      "routines",
                    ),
                  )
                }
              >
                {item.enabled ? personal.pauseReminder : personal.resumeReminder}
              </button>
            )}
          </ListRow>
        ))}
      </ListCard>
    </section>
  );
}

/**
 * A user's own reminders and routines on one agent. She sees, pauses and deletes them
 * at every level and creates and changes them from Personalize on (me-reminders.js).
 */
export default function UserRemindersGroup({ agentId, level }) {
  const readOnly = level === "chat";
  return (
    <>
      {/* At Chat only her agent cannot set any up either (reminder-audience.js). */}
      <RemindersGroup
        assistantId={agentId}
        api={reminderApi}
        readOnly={readOnly}
        canStop
        hint={readOnly ? copy.remindersChatOnly : undefined}
      />
      <UserRoutines agentId={agentId} readOnly={readOnly} />
    </>
  );
}
