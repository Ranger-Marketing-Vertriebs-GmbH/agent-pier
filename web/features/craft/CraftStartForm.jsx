import React, { useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { NumberRow, SelectRow, ToggleRow } from "../../components/ListRow.jsx";
import Segmented from "../../components/Segmented.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { localName } from "../../lib/server-names.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { craftCopy } from "../../lib/i18n/messages/craft.js";
import { isShortProjectName, shownProjectName } from "./start-project-name.js";
import CraftPictures from "./CraftPictures.jsx";
import useCraftPictures from "./useCraftPictures.js";

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

/** The eligible accounts as select options, generated names in the page's language. */
export const accountOptions = (accounts) =>
  accounts.map((account) => ({
    value: account.id,
    label: localName(account) || account.id,
  }));

// Craft Anything's stack values (server/features/craft/craft-stacks.js) that read
// differently in the page's language; the others are product names.
const stackKeys = {
  "Builder's choice": "builderChoice",
  "Plain HTML and CSS": "plainHtml",
  "Rust (console)": "rustConsole",
  unity: "unity",
  unreal: "unreal",
  godot: "godot",
};

/** A stack value as the form shows it ("unity" → "Unity"). */
export const stackLabel = (stack) => craftCopy.stacks[stackKeys[stack]] ?? stack;

/** The target's Segmented options. */
export const targetOptions = () => [
  { value: "none", label: craftCopy.start.targetNone },
  { value: "url", label: craftCopy.start.targetUrl },
  { value: "path", label: craftCopy.start.targetPath },
  { value: "pictures", label: craftCopy.start.targetPictures },
];

/**
 * The start form: what to make, the project's short name (prefilled from the request
 * and target, required, never prose), the target (none, a web address, a local path or
 * screenshots alone), screenshots of the look for an address or a path, stack,
 * account, mode, auto mode and rounds, preset from the owner's defaults. Pictures
 * upload only when the form is sent. `onStarted(view)` hears the new rebuild.
 */
export default function CraftStartForm({ data, start, onStarted }) {
  const copy = craftCopy.start;
  // Generated account names follow the English server catalog once it has loaded.
  useLanguage();
  const id = useId();
  const action = useAsyncAction();
  const requestId = useRef(newRequestId());
  const pictures = useCraftPictures();
  const accounts = data.accounts || [];
  const [form, setForm] = useState(() => ({
    request: "",
    name: "",
    nameEdited: false,
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
  // The defaults the owner did not change here follow a save of Defaults.
  const touched = useRef(new Set());
  const set = (key) => (value) => {
    touched.current.add(key);
    setForm((held) => ({ ...held, [key]: value }));
  };
  const { accountId, mode, autoMode } = data.settings || {};
  useEffect(() => {
    const next = {};
    if (!touched.current.has("accountId") && accounts.some((a) => a.id === accountId))
      next.accountId = accountId;
    if (!touched.current.has("mode") && mode) next.mode = mode;
    if (!touched.current.has("autoMode")) next.autoMode = autoMode === true;
    setForm((held) => ({ ...held, ...next }));
    // Only a change of the saved defaults applies; the account list alone does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, mode, autoMode]);
  const kind = form.targetKind;
  const withPictures = kind !== "none";
  const name = shownProjectName(form).trim();
  const nameTooLong = !!name && !isShortProjectName(name);
  const submit = (event) => {
    event.preventDefault();
    action.run(async () => {
      if (!name || nameTooLong) throw new Error(copy.nameRequired);
      if (kind === "pictures" && !pictures.items.length)
        throw new Error(craftCopy.pictures.required);
      const ids = withPictures ? await pictures.upload() : [];
      let view;
      try {
        view = await start({
          request: form.request,
          name,
          target: kind === "none" || kind === "pictures" ? "-" : form.target.trim(),
          ...(ids.length && { pictures: ids }),
          stack: form.stack,
          accountId: form.accountId,
          mode: form.mode,
          autoMode: form.autoMode,
          rounds: form.rounds === "" ? undefined : form.rounds,
          requestId: requestId.current,
        });
      } finally {
        // The server releases sent pictures whatever it answers.
        if (ids.length) pictures.sent();
      }
      requestId.current = newRequestId();
      pictures.clear();
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
              options={targetOptions()}
            />
          </div>
          {(kind === "url" || kind === "path") && (
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
          {withPictures && (
            <CraftPictures
              pictures={pictures}
              hint={
                kind === "pictures"
                  ? craftCopy.pictures.hint
                  : craftCopy.pictures.lookHint
              }
              disabled={action.busy}
            />
          )}
          <label className="craft-row-field">
            {copy.name}
            <input
              type="text"
              required
              spellCheck={false}
              autoComplete="off"
              placeholder={copy.namePlaceholder}
              aria-invalid={nameTooLong || undefined}
              aria-describedby={`${id}-name-note`}
              value={shownProjectName(form)}
              onChange={(event) =>
                setForm((held) => ({
                  ...held,
                  name: event.target.value,
                  nameEdited: true,
                }))
              }
            />
          </label>
          <p id={`${id}-name-note`} className="craft-row-note">
            {nameTooLong ? copy.nameTooLong : copy.nameHint}
          </p>
          <SelectRow
            label={copy.stack}
            value={form.stack}
            onChange={set("stack")}
            options={(data.stacks || []).map((stack) => ({
              value: stack,
              label: stackLabel(stack),
            }))}
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
            sub={copy.roundsHint}
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
