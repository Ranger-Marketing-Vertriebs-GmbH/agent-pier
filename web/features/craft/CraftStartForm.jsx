import React, { useId, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { NumberRow, SelectRow, ToggleRow } from "../../components/ListRow.jsx";
import Segmented from "../../components/Segmented.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { craftCopy } from "../../lib/i18n/messages/craft.js";

// A start's retry key: the same key returns the rebuild it started, so a double click
// or a resent request never starts twice. crypto.randomUUID needs a secure context.
const newRequestId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The mode's Segmented options. */
export const modeOptions = () => [
  { value: "clean-room", label: craftCopy.start.cleanRoom },
  { value: "deep", label: craftCopy.start.deep },
];

/** The eligible accounts as select options. */
export const accountOptions = (accounts) =>
  accounts.map((account) => ({ value: account.id, label: account.name || account.id }));

/**
 * The start form: what to make, the target (none, a web address or a local path),
 * stack, account, mode, auto mode and rounds, preset from the owner's defaults.
 * `onStarted(view)` hears the new rebuild.
 */
export default function CraftStartForm({ data, start, onStarted }) {
  const copy = craftCopy.start;
  const id = useId();
  const action = useAsyncAction();
  const requestId = useRef(newRequestId());
  const accounts = data.accounts || [];
  const [form, setForm] = useState(() => ({
    request: "",
    targetKind: "none",
    target: "",
    stack: data.stacks?.[0] ?? "",
    accountId: accounts.some((a) => a.id === data.settings?.accountId)
      ? data.settings.accountId
      : (accounts[0]?.id ?? ""),
    mode: data.settings?.mode ?? "clean-room",
    autoMode: data.settings?.autoMode === true,
    rounds: 2,
  }));
  const set = (key) => (value) => setForm((held) => ({ ...held, [key]: value }));
  const submit = (event) => {
    event.preventDefault();
    action.run(async () => {
      const view = await start({
        request: form.request,
        target: form.targetKind === "none" ? "-" : form.target.trim(),
        stack: form.stack,
        accountId: form.accountId,
        mode: form.mode,
        autoMode: form.autoMode,
        rounds: form.rounds === "" ? undefined : form.rounds,
        requestId: requestId.current,
      });
      requestId.current = newRequestId();
      onStarted(view);
    });
  };
  const targetLabel = form.targetKind === "url" ? copy.urlLabel : copy.pathLabel;
  return (
    <section className="craft-section" aria-labelledby={`${id}-title`}>
      <GroupLabel id={`${id}-title`}>{copy.title}</GroupLabel>
      <form className="craft-start" onSubmit={submit}>
        <label>
          {copy.request}
          <textarea
            dir="auto"
            rows={3}
            required
            maxLength={8000}
            placeholder={copy.requestPlaceholder}
            value={form.request}
            onChange={(event) => set("request")(event.target.value)}
          />
        </label>
        <ListCard labelledBy={`${id}-title`}>
          <div className="list-row craft-choice-row">
            <span className="list-row-label" aria-hidden="true">
              {copy.target}
            </span>
            <Segmented
              label={copy.target}
              value={form.targetKind}
              onChange={set("targetKind")}
              options={[
                { value: "none", label: copy.targetNone },
                { value: "url", label: copy.targetUrl },
                { value: "path", label: copy.targetPath },
              ]}
            />
          </div>
          {form.targetKind !== "none" && (
            <label className="craft-row-field">
              {targetLabel}
              <input
                type={form.targetKind === "url" ? "url" : "text"}
                required
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  form.targetKind === "url" ? "https://example.com" : "/Applications/…"
                }
                value={form.target}
                onChange={(event) => set("target")(event.target.value)}
              />
            </label>
          )}
          <SelectRow
            label={copy.stack}
            value={form.stack}
            onChange={set("stack")}
            options={(data.stacks || []).map((stack) => ({ value: stack, label: stack }))}
          />
          {accounts.length > 0 && (
            <SelectRow
              label={copy.account}
              value={form.accountId}
              onChange={set("accountId")}
              options={accountOptions(accounts)}
            />
          )}
          <div className="list-row craft-choice-row">
            <span className="list-row-label" aria-hidden="true">
              {copy.mode}
            </span>
            <Segmented
              label={copy.mode}
              value={form.mode}
              onChange={set("mode")}
              options={modeOptions()}
            />
          </div>
          <p className="craft-row-note">{copy.modeHint}</p>
          <ToggleRow
            label={copy.autoMode}
            sub={copy.autoModeHint}
            checked={form.autoMode}
            onChange={set("autoMode")}
          />
          <NumberRow
            label={copy.rounds}
            value={form.rounds}
            min={1}
            max={10}
            step={1}
            onChange={set("rounds")}
          />
        </ListCard>
        {accounts.length === 0 && <p className="craft-note">{copy.noAccounts}</p>}
        <p className="form-note">{copy.consent}</p>
        <ErrorMessage error={action.error} />
        <div className="craft-actions">
          <button
            type="submit"
            className="button primary"
            disabled={action.busy || accounts.length === 0}
          >
            {action.busy ? copy.starting : copy.submit}
          </button>
        </div>
      </form>
    </section>
  );
}
