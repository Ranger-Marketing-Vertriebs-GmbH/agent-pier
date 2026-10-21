import React, { useCallback, useEffect, useState } from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { usersCopy as copy } from "../../lib/i18n/messages/users.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { ownerUsersApi } from "./owner-users-api.js";
import UserDetail from "./UserDetail.jsx";
import "./users-page.css";

function AddUserSheet({ onCreated, onCancel }) {
  return (
    <Modal title={copy.addTitle} close={onCancel}>
      <AsyncForm
        button={copy.create}
        close={onCancel}
        submit={async (data) => {
          const user = await ownerUsersApi.create({
            displayName: String(data.get("displayName") || "").trim(),
            username: String(data.get("username") || "").trim(),
            password: String(data.get("password") || ""),
          });
          onCreated(user);
        }}
      >
        <label>
          {copy.displayName}
          <input name="displayName" required maxLength={100} autoComplete="off" />
        </label>
        <label>
          {copy.username}
          <input
            name="username"
            required
            maxLength={100}
            autoComplete="off"
            autoCapitalize="none"
          />
        </label>
        <label>
          {copy.firstPassword}
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={1024}
            autoComplete="new-password"
            aria-describedby="users-password-hint"
          />
        </label>
        <p id="users-password-hint" className="users-hint">
          {copy.passwordHint}
        </p>
      </AsyncForm>
    </Modal>
  );
}

/**
 * Settings › Access › Users: one row per restricted user and Add user; a row opens her
 * detail (?user=<id>) with her account, the opt-in, her agents and their levels.
 */
export default function UsersPage({ route, navigate, frame }) {
  const [users, setUsers] = useState(null);
  const [agents, setAgents] = useState({ assistants: [], available: false });
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try {
      setUsers(await ownerUsersApi.list());
      setError("");
    } catch (e) {
      setError(e.message);
    }
    // Agents may be off: then there are no agents to list, users still are.
    try {
      const list = await assistantApi.list();
      setAgents({ assistants: list.assistants || [], available: true });
    } catch {
      setAgents({ assistants: [], available: false });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const open = (userId) => navigate({ userId });
  if (route.userId)
    return (
      <UserDetail
        userId={route.userId}
        users={users}
        agents={agents}
        reload={load}
        onClose={() => navigate({ userId: undefined })}
        frame={frame}
      />
    );
  return (
    <section className="users-page">
      <p className="users-intro">{copy.intro}</p>
      <div>
        <button type="button" className="button primary" onClick={() => setAdding(true)}>
          {copy.add}
        </button>
      </div>
      <ErrorMessage error={error} />
      {users === null ? (
        <p role="status">{copy.loading}</p>
      ) : users.length ? (
        <ListCard label={copy.add}>
          {users.map((user) => (
            <ListRow
              key={user.id}
              label={user.displayName}
              sub={user.username}
              value={user.disabled ? copy.disabled : undefined}
              onClick={() => open(user.id)}
            />
          ))}
        </ListCard>
      ) : (
        <p className="users-hint">{copy.empty}</p>
      )}
      {adding && (
        <AddUserSheet
          onCancel={() => setAdding(false)}
          onCreated={async (user) => {
            setAdding(false);
            await load();
            open(user.id);
          }}
        />
      )}
    </section>
  );
}
