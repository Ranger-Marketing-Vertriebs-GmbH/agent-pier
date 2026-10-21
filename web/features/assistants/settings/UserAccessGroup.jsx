import React, { useEffect, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { CheckboxRow } from "../../../components/ListRow.jsx";
import Segmented from "../../../components/Segmented.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { memberGrantCopy } from "../../../lib/i18n/messages/assistant-member-grants.js";
import { usersCopy as copy } from "../../../lib/i18n/messages/users.js";
import { ownerUsersApi, withMember } from "../../users/owner-users-api.js";
import useAssistants from "../useAssistants.js";

const levels = ["chat", "personalize", "extended"];
// The web capabilities an Extended user may switch herself (native-capabilities.js).
const releasable = [
  "webSearch",
  "webFetch",
  "browser",
  "documents",
  "readPdfs",
  "createImages",
];

/**
 * Who uses an agent of users and how much each may configure: one level control per
 * member, the capabilities released for Extended on a user's own agent, and Remove on a
 * shared agent. Every
 * change applies at once through the owner's user-agents route.
 */
export default function UserAccessGroup({ assistant }) {
  const { refresh } = useAssistants();
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ownerUsersApi
      .list()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);
  const access = assistant.userAccess;
  if (!access) return null;
  const nameOf = (userId) =>
    users.find((u) => u.id === userId)?.displayName || copy.unknownUser;
  const save = async (next) => {
    setBusy(true);
    setError("");
    try {
      await ownerUsersApi.assign(assistant.id, next, assistant.revision);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const released = access.released || [];
  return (
    <section className="agent-user-access" aria-labelledby="agent-user-access">
      <GroupLabel
        id="agent-user-access"
        hint={access.mode === "shared" ? copy.accessHint : undefined}
      >
        {copy.access}
      </GroupLabel>
      <ErrorMessage error={error} />
      <ListCard labelledBy="agent-user-access">
        {access.members.map((member) => (
          <div key={member.userId} className="users-agent">
            <ListRow
              label={nameOf(member.userId)}
              sub={access.mode === "own" ? copy.own : copy.shared}
              onDelete={
                access.mode === "shared" && access.members.length > 1
                  ? () => save(withMember(access, member.userId, null))
                  : undefined
              }
              deleteLabel={copy.remove(nameOf(member.userId))}
              disabled={busy}
            />
            <Segmented
              label={copy.levelFor(nameOf(member.userId))}
              value={member.level}
              disabled={busy}
              onChange={(level) => save(withMember(access, member.userId, level))}
              options={levels.map((value) => ({ value, label: copy.levels[value] }))}
            />
          </div>
        ))}
      </ListCard>
      {/* A shared agent's capabilities stay the owner's at every level
          (user-agent-settings.js), so only a user's own agent releases any. */}
      {access.mode === "own" && (
        <>
          <GroupLabel id="agent-user-released" hint={copy.releasedHint}>
            {copy.released}
          </GroupLabel>
          <ListCard labelledBy="agent-user-released">
            {releasable.map((key) => (
              <CheckboxRow
                key={key}
                label={memberGrantCopy.labels[key]}
                checked={released.includes(key)}
                disabled={busy}
                onChange={(on) =>
                  save({
                    ...access,
                    released: on
                      ? [...released, key].sort()
                      : released.filter((item) => item !== key),
                  })
                }
              />
            ))}
          </ListCard>
        </>
      )}
    </section>
  );
}
