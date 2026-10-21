import React, { useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { ToggleRow } from "../../components/ListRow.jsx";
import Segmented from "../../components/Segmented.jsx";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { useCrossLink } from "../../app/cross-link.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { usersCopy as copy } from "../../lib/i18n/messages/users.js";
import { agentsOf, ownerUsersApi, withMember } from "./owner-users-api.js";
import DeleteUserSheet from "./DeleteUserSheet.jsx";

const levels = ["chat", "personalize", "extended"];

function PasswordReset({ user, onDone, onCancel }) {
  return (
    <Modal title={copy.resetTitle(user.displayName)} close={onCancel}>
      <AsyncForm
        button={copy.reset}
        close={onCancel}
        submit={async (data) => {
          await ownerUsersApi.resetPassword(user.id, String(data.get("password") || ""));
          onDone();
        }}
      >
        <label>
          {copy.newPassword}
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={1024}
            autoComplete="new-password"
            aria-describedby="users-reset-hint"
          />
        </label>
        <p id="users-reset-hint" className="users-hint">
          {copy.resetHint}
        </p>
      </AsyncForm>
    </Modal>
  );
}

function JoinShared({ user, shared, onDone, onCancel }) {
  return (
    <Modal title={copy.joinTitle} close={onCancel}>
      <AsyncForm
        button={copy.join}
        close={onCancel}
        submit={async (data) => {
          const agent = shared.find((a) => a.id === data.get("agent"));
          await ownerUsersApi.assign(
            agent.id,
            withMember(agent.userAccess, user.id, "chat"),
            agent.revision,
          );
          onDone();
        }}
      >
        <label>
          {copy.joinLabel}
          <select name="agent" required>
            {shared.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      </AsyncForm>
    </Modal>
  );
}

/**
 * One restricted user: her account (Reset password, sign-in allowed), whether the
 * owner may read her chats, her own and shared agents with their level, and Delete.
 * Every change applies at once, as account actions do.
 */
export default function UserDetail({ userId, users, agents, reload, onClose, frame }) {
  const crossLink = useCrossLink();
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const user = users?.find((u) => u.id === userId);
  if (!users) return <p role="status">{copy.loading}</p>;
  if (!user)
    return (
      <section className="users-page">
        <p>{copy.notFound}</p>
        <button type="button" className="button secondary" onClick={onClose}>
          {copy.allUsers}
        </button>
      </section>
    );
  const act = async (work) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const hers = agentsOf(agents.assistants, user.id);
  const otherShared = agents.assistants.filter(
    (a) =>
      !a.archivedAt &&
      a.userAccess?.mode === "shared" &&
      !a.userAccess.members.some((m) => m.userId === user.id),
  );
  const ownsAgents = hers.some(({ agent }) => agent.userAccess.mode === "own");
  const openAgent = (agent) =>
    frame?.go(crossLink({ view: "agents", assistantId: agent.id, agentSettings: true }));
  return (
    <section className="users-page">
      <div className="users-detail-head">
        <h2 className="users-detail-name">{user.displayName}</h2>
        <button type="button" className="button text" onClick={onClose}>
          {copy.allUsers}
        </button>
      </div>
      <ErrorMessage error={error} />
      {notice && (
        <p role="status" className="users-hint">
          {notice}
        </p>
      )}
      <GroupLabel id="users-account">{copy.account}</GroupLabel>
      <ListCard labelledBy="users-account">
        <ListRow label={copy.username} value={user.username} />
        <ListRow label={copy.resetPassword} onClick={() => setDialog("reset")} />
        <ToggleRow
          label={copy.active}
          sub={copy.activeSub}
          checked={!user.disabled}
          disabled={busy}
          onChange={(on) => act(() => ownerUsersApi.update(user.id, { disabled: !on }))}
        />
        <ToggleRow
          label={copy.ownerMayRead}
          sub={
            user.ownerMayRead?.enabled
              ? `${copy.ownerMayReadSince(formatTimestamp(user.ownerMayRead.since))} · ${copy.ownerMayReadSub}`
              : copy.ownerMayReadSub
          }
          checked={user.ownerMayRead?.enabled === true}
          disabled={busy}
          onChange={(on) => act(() => ownerUsersApi.setOwnerMayRead(user.id, on))}
        />
      </ListCard>
      {agents.available && (
        <>
          <GroupLabel id="users-agents" hint={copy.agentsHint}>
            {copy.agents}
          </GroupLabel>
          <ListCard labelledBy="users-agents">
            {!hers.length && <p className="agent-row-note">{copy.noAgents}</p>}
            {hers.map(({ agent, level }) => (
              <div key={agent.id} className="users-agent">
                <ListRow
                  label={agent.name}
                  sub={agent.userAccess.mode === "own" ? copy.own : copy.shared}
                  onClick={() => openAgent(agent)}
                />
                <Segmented
                  label={copy.levelFor(agent.name)}
                  value={level}
                  disabled={busy}
                  onChange={(next) =>
                    act(() =>
                      ownerUsersApi.assign(
                        agent.id,
                        withMember(agent.userAccess, user.id, next),
                        agent.revision,
                      ),
                    )
                  }
                  options={levels.map((value) => ({ value, label: copy.levels[value] }))}
                />
              </div>
            ))}
          </ListCard>
          <div className="users-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                frame?.go(crossLink({ view: "agents", creating: true, forUser: user.id }))
              }
            >
              {copy.addAgent}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!otherShared.length}
              onClick={() => setDialog("join")}
            >
              {copy.joinShared}
            </button>
          </div>
          {!otherShared.length && <p className="users-hint">{copy.noShared}</p>}
        </>
      )}
      <div className="users-actions">
        <button
          type="button"
          className="button destructive"
          onClick={() => setDialog("delete")}
        >
          {copy.delete}
        </button>
      </div>
      {dialog === "reset" && (
        <PasswordReset
          user={user}
          onCancel={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setNotice(copy.passwordReset);
          }}
        />
      )}
      {dialog === "join" && (
        <JoinShared
          user={user}
          shared={otherShared}
          onCancel={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            await reload();
          }}
        />
      )}
      {dialog === "delete" && (
        <DeleteUserSheet
          user={user}
          ownsAgents={ownsAgents}
          onCancel={() => setDialog(null)}
          onDeleted={async () => {
            setDialog(null);
            await reload();
            onClose();
          }}
        />
      )}
    </section>
  );
}
