import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import CopyButton from "../../../components/CopyButton.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { NumberRow, ToggleRow } from "../../../components/ListRow.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import api from "../../../lib/api.js";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { hookCopy as copy } from "../../../lib/i18n/messages/assistant-hooks.js";
import { hookApi } from "./hook-api.js";
import { hookAddress, hookDraft, hookPatch, hookTicks } from "./hook-fields.js";
import HookRights from "./HookRights.jsx";
import HookSecretDialog from "./HookSecretDialog.jsx";
import ConflictNotice from "./ConflictNotice.jsx";
import SubpageHeader from "./SubpageHeader.jsx";
import useAgentDraftGuard from "./useAgentDraftGuard.js";

const draftKeys = Object.keys(
  hookDraft({ rights: { sshHosts: [], folders: {} }, instruction: "" }),
);
const validLimit = (value) => Number.isInteger(value) && value >= 1 && value <= 200;
const conflictLabels = {
  name: () => copy.name,
  sender: () => copy.sender,
  instruction: () => copy.instruction,
  hourlyLimit: () => copy.hourlyLimit,
  enabled: () => copy.enabled,
  shell: () => copy.shell,
  sshHosts: () => copy.sshHosts,
  folders: () => copy.folders,
  ...Object.fromEntries(hookTicks.map((key) => [key, () => copy.ticks[key]])),
};

/** Address rows with a copy button each, and why the others are missing. */
function HookAddresses({ addresses }) {
  const id = useId();
  const rows = [
    ["local", addresses.local],
    ...(addresses.tailscale ? [["tailscale", addresses.tailscale]] : []),
    ...addresses.network.map((url) => ["network", url]),
  ];
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id}>{copy.addresses}</GroupLabel>
      <ListCard labelledBy={id}>
        {rows.map(([place, url]) => (
          <ListRow key={url} label={copy.places[place]} sub={url}>
            <CopyButton
              iconOnly
              className="icon-button"
              text={url}
              label={copy.copyAddress(copy.places[place])}
            />
          </ListRow>
        ))}
        {!addresses.tailscale && <p className="agent-row-note">{copy.tailscaleOff}</p>}
        {!addresses.network.length && <p className="agent-row-note">{copy.networkOff}</p>}
      </ListCard>
    </section>
  );
}

/**
 * One hook's detail (`page=hook&hook=<id>`): its fields and rights as a draft with
 * one save bar, its addresses, and the immediate actions (secret, test, delete).
 * Rights the agent lost since stay as saved but show disabled with the reason.
 */
export default function HookPage({ assistant, hookId, onBack }) {
  const assistantId = assistant.id;
  const [view, setView] = useState(null),
    [loadError, setLoadError] = useState(""),
    [catalog, setCatalog] = useState(null),
    [asking, setAsking] = useState(null),
    [reveal, setReveal] = useState(null),
    [notice, setNotice] = useState(""),
    [actionError, setActionError] = useState(""),
    [busy, setBusy] = useState(false),
    [gone, setGone] = useState(false);
  const actionsId = useId();
  // Revisions this page bumped itself (a new secret), so a pending save follows them.
  const bumps = useRef(new Map());
  const latest = useRef(null);
  latest.current = view?.hook;
  const load = useCallback(async () => {
    const result = await hookApi.list(assistantId);
    const hook = result.hooks?.find((item) => item.id === hookId) ?? null;
    setView({ hook });
    return hook;
  }, [assistantId, hookId]);
  useEffect(() => {
    let alive = true;
    load().catch((e) => alive && setLoadError(e.message));
    // Names of folders and SSH hosts; the rows fall back to ids without them.
    api("/assistant-workspace-catalog").then(
      (list) => alive && setCatalog(list),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [load]);
  const hook = view?.hook ?? null;
  const draft = useTabDraft({
    server: hook ? hookDraft(hook) : null,
    revisions: hook ? { hook: hook.revision } : {},
    refresh: async () => {
      const fresh = await load();
      return fresh
        ? { server: hookDraft(fresh), revisions: { hook: fresh.revision } }
        : {};
    },
  });
  const ownRevision = (revision) => {
    let current = revision;
    while (bumps.current.has(current)) current = bumps.current.get(current);
    return current;
  };
  const steps = [
    {
      id: "hook",
      label: copy.title,
      keys: draftKeys,
      resource: "hook",
      run: async ({ values, revision }) => {
        const saved = latest.current;
        const result = await hookApi.update(
          assistantId,
          hookId,
          hookPatch(values, { ...saved, revision: ownRevision(revision) }),
        );
        setView({ hook: result });
        return result;
      },
    },
  ];
  // The draft takes the loaded hook one render later.
  const values = hook ? { ...hookDraft(hook), ...draft.values } : draft.values;
  const invalid = hook && !validLimit(values.hourlyLimit);
  const save = async () => (invalid ? { status: "invalid" } : draft.save(steps));
  const overwrite = async () =>
    invalid ? { status: "invalid" } : draft.overwrite(steps);
  const sheet = useAgentDraftGuard({
    draft,
    assistantId,
    tab: "automation",
    page: "hook",
    label: hook?.name || copy.unknownName,
    save,
  });
  // Back to the list once a deletion has discarded the draft.
  const leave = useRef(onBack);
  leave.current = onBack;
  useEffect(() => {
    if (gone && !draft.dirty) leave.current();
  }, [gone, draft.dirty]);
  async function act(operation) {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const newSecret = async () => {
    const before = hook.revision;
    const result = await hookApi.secret(assistantId, hookId, before);
    bumps.current.set(before, result.hook.revision);
    setView({ hook: result.hook });
    setAsking(null);
    setReveal({ secret: result.secret, address: hookAddress(result.hook.addresses) });
  };
  const sendTest = () =>
    act(async () => {
      const result = await hookApi.test(assistantId, hookId);
      setNotice(copy.testStatus[result.status] || copy.testStatus.accepted);
    });
  const remove = async () => {
    await hookApi.remove(assistantId, hookId);
    setAsking(null);
    draft.reset();
    setGone(true);
  };
  const title = hook?.name || copy.unknownName;
  if (!view || !hook)
    return (
      <section className="agent-subpage" aria-label={title}>
        <SubpageHeader title={title} tab="automation" onBack={onBack} />
        <ErrorMessage error={loadError} />
        {!loadError && (
          <p role={view ? undefined : "status"} className="assistant-note">
            {view ? copy.notFound : copy.loading}
          </p>
        )}
      </section>
    );
  const disabled = draft.saving || gone;
  const field = (key, input, hint) => (
    <div className="agent-field">
      <label htmlFor={`${actionsId}-${key}`}>{copy[key]}</label>
      {input({
        id: `${actionsId}-${key}`,
        value: values[key] ?? "",
        disabled,
        onChange: (event) => draft.set(key, event.target.value),
        "aria-describedby": hint ? `${actionsId}-${key}-hint` : undefined,
      })}
      {hint && (
        <span id={`${actionsId}-${key}-hint`} className="field-description">
          {hint}
        </span>
      )}
    </div>
  );
  return (
    <section className="agent-subpage" aria-label={title}>
      <SubpageHeader
        title={title}
        tab="automation"
        onBack={onBack}
        hint={copy.description}
      />
      <ConflictNotice draft={draft} labels={conflictLabels} />
      <div className="list-card agent-fields">
        {field("name", (props) => (
          <input {...props} required maxLength={100} />
        ))}
        {field(
          "sender",
          (props) => (
            <input {...props} required maxLength={100} />
          ),
          copy.senderHint,
        )}
        {field(
          "instruction",
          (props) => (
            <textarea {...props} rows={4} maxLength={4096} />
          ),
          copy.instructionHint,
        )}
      </div>
      <HookRights
        hook={hook}
        values={values}
        set={draft.set}
        disabled={disabled}
        catalog={catalog}
      />
      <ListCard label={copy.hourlyLimit}>
        <NumberRow
          label={copy.hourlyLimit}
          sub={invalid ? copy.invalidLimit : copy.hourlyLimitHint}
          value={values.hourlyLimit}
          min={1}
          max={200}
          disabled={disabled}
          onChange={(next) => draft.set("hourlyLimit", next)}
        />
        <ToggleRow
          label={copy.enabled}
          sub={copy.enabledHint}
          checked={values.enabled === true}
          disabled={disabled}
          onChange={(next) => draft.set("enabled", next)}
        />
      </ListCard>
      <HookAddresses addresses={hook.addresses} />
      <section aria-labelledby={actionsId}>
        <GroupLabel id={actionsId}>{copy.actions}</GroupLabel>
        {!hook.secretSet && <p className="assistant-note">{copy.noSecret}</p>}
        <div className="assistant-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || gone}
            onClick={() => (hook.secretSet ? setAsking("regenerate") : act(newSecret))}
          >
            {hook.secretSet ? copy.regenerateSecret : copy.createSecret}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || gone}
            onClick={sendTest}
          >
            {copy.sendTest}
          </button>
          <button
            type="button"
            className="button destructive"
            disabled={busy || gone}
            onClick={() => setAsking("delete")}
          >
            {copy.delete}
          </button>
        </div>
        {notice && (
          <p role="status" className="agent-row-note">
            {notice}
          </p>
        )}
        <ErrorMessage error={actionError} />
      </section>
      <SaveBar draft={draft} onSave={save} onOverwrite={overwrite} />
      <UnsavedChangesSheet {...sheet} />
      {asking === "regenerate" && (
        <ConfirmDialog
          title={copy.regenerateTitle(hook.name)}
          body={copy.regenerateBody}
          confirmLabel={copy.regenerateSecret}
          focusCancel
          onConfirm={newSecret}
          onCancel={() => setAsking(null)}
        />
      )}
      {asking === "delete" && (
        <ConfirmDialog
          destructive
          title={copy.deleteTitle(hook.name)}
          body={copy.deleteBody}
          confirmLabel={copy.deleteConfirm}
          onConfirm={remove}
          onCancel={() => setAsking(null)}
        />
      )}
      {reveal && <HookSecretDialog {...reveal} onClose={() => setReveal(null)} />}
    </section>
  );
}
