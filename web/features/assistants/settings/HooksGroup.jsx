import React, { useEffect, useId, useState } from "react";
import AsyncForm from "../../../components/AsyncForm.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import Modal from "../../../components/Modal.jsx";
import { routePath } from "../../../app/routes.js";
import { hookCopy as copy } from "../../../lib/i18n/messages/assistant-hooks.js";
import { agentRoute } from "./agent-settings-fields.js";
import { hookApi } from "./hook-api.js";
import { hookAddress, hookState } from "./hook-fields.js";
import HookSecretDialog from "./HookSecretDialog.jsx";

/**
 * The agent's hooks: one row per hook into its detail subpage, and "+ Add", which
 * creates a hook from a name and a sender and reveals its secret once. `paused`
 * (reminders and routines off) keeps the list of inactive hooks, so they can be
 * deleted.
 */
export default function HooksGroup({ assistantId, paused = false, navigate }) {
  const id = useId();
  const [hooks, setHooks] = useState(null),
    [error, setError] = useState(""),
    [adding, setAdding] = useState(false),
    [reveal, setReveal] = useState(null);
  useEffect(() => {
    let alive = true;
    hookApi.list(assistantId).then(
      (result) => alive && setHooks(result.hooks || []),
      (e) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [assistantId]);
  const route = (hookId) => agentRoute(assistantId, "automation", "hook", hookId);
  async function create(data) {
    const name = String(data.get("name") || "").trim(),
      sender = String(data.get("sender") || "").trim();
    const { hook, secret } = await hookApi.create(assistantId, { name, sender });
    setAdding(false);
    setHooks((list) => [...(list || []), hook]);
    setReveal({ secret, address: hookAddress(hook.addresses) });
  }
  return (
    <section id="agent-hooks" aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={copy.description}
        action={{
          label: copy.add,
          onClick: () => setAdding(true),
          disabled: paused || hooks === null,
        }}
      >
        {copy.title}
      </GroupLabel>
      <ErrorMessage error={error} />
      {paused && <p className="assistant-note">{copy.paused}</p>}
      <ListCard labelledBy={id}>
        {hooks === null && !error && (
          <p role="status" className="agent-row-note">
            {copy.loading}
          </p>
        )}
        {hooks?.length === 0 && <p className="agent-row-note">{copy.empty}</p>}
        {(hooks || []).map((hook) => (
          <ListRow
            key={hook.id}
            label={hook.name || copy.unknownName}
            sub={`${hook.sender} · ${copy.states[hookState(hook)]}`}
            href={routePath(route(hook.id))}
            onClick={() => navigate(route(hook.id))}
          />
        ))}
      </ListCard>
      {adding && (
        <Modal title={copy.createTitle} close={() => setAdding(false)}>
          <AsyncForm submit={create} button={copy.create} close={() => setAdding(false)}>
            <label>
              {copy.name}
              <input name="name" maxLength={100} required autoComplete="off" />
            </label>
            <label>
              {copy.sender}
              <input
                name="sender"
                maxLength={100}
                required
                autoComplete="off"
                aria-describedby={`${id}-sender`}
              />
            </label>
            <p id={`${id}-sender`} className="field-description">
              {copy.senderHint}
            </p>
          </AsyncForm>
        </Modal>
      )}
      {reveal && <HookSecretDialog {...reveal} onClose={() => setReveal(null)} />}
    </section>
  );
}
