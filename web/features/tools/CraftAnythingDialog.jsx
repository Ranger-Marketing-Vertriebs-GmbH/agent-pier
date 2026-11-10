import React, { useEffect, useRef, useState } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import Switch from "../../components/Switch.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { craftAnythingCopy as copy } from "../../lib/i18n/messages/craft-anything.js";
import { reaCopy } from "../../lib/i18n/messages/rea.js";
import { names } from "../../lib/providers.js";
import { serverText } from "../../lib/server-messages.js";
import {
  GhidraRow,
  PartsTotal,
  Sizes,
  ToolStatus,
  ghidraCosts,
  versionLine,
} from "./ToolParts.jsx";
import useCraftAnything from "./useCraftAnything.js";

const statusLabels = {
  get running() {
    return copy.statusRunning;
  },
  get failed() {
    return reaCopy.statusFailed;
  },
  get succeeded() {
    return reaCopy.statusSucceeded;
  },
  get background() {
    return copy.backgroundNote;
  },
};

/**
 * The form's start: Craft Anything's own Ghidra choice (REA may keep Ghidra installed)
 * and mode, or before an install clean room, with Ghidra only when it is installed
 * already (REA's, at no cost): clean room never needs it.
 */
const draftFrom = (state) => ({
  ghidra: state.serverId
    ? state.components.ghidra.wanted
    : state.components.ghidra.available && state.components.ghidra.installed,
  mode: state.settings?.mode === "deep" ? "deep" : "clean-room",
});

/** What the update brings: the CLI's pinned version, the Ghidra/JDK pins, or both. */
function updateNote({ core, ghidra }) {
  const parts = [];
  if (core.outdated || !ghidra.outdated) parts.push(copy.updateCore(core.pinnedVersion));
  if (ghidra.outdated)
    parts.push(reaCopy.updateGhidra(ghidra.pinnedVersion, ghidra.jdkPinnedVersion));
  return copy.updateNote(parts.join(", "));
}

function Components({ components, draft, onChange, disabled }) {
  const { core, ghidra } = components;
  const parts = [core, ...(draft.ghidra && ghidraCosts(ghidra) ? [ghidra] : [])];
  return (
    <fieldset className="check-list rea-components">
      <legend>{copy.componentsLabel}</legend>
      <CheckRow title={copy.core} subtitle={copy.coreDescription} checked disabled>
        <span className="check-row-subtitle">
          {versionLine(core.installed, core.version, core.pinnedVersion)}
        </span>
        <Sizes part={core} />
      </CheckRow>
      <GhidraRow
        ghidra={ghidra}
        checked={draft.ghidra}
        disabled={disabled}
        sharedWith={names.rea}
        onChange={(checked) => onChange({ ...draft, ghidra: checked })}
      />
      <PartsTotal parts={parts} />
    </fieldset>
  );
}

function ResponsibleUse() {
  return (
    <section className="rea-section" aria-labelledby="craft-responsible">
      <h3 id="craft-responsible">{copy.responsibleLabel}</h3>
      <ul className="rea-notes">
        <li>{copy.responsibleOwn}</li>
        <li>{copy.responsibleBypass}</li>
        <li>{copy.responsibleAlpha}</li>
        <li>{copy.responsibleRestricted}</li>
        <li>{copy.responsibleCleanRoom}</li>
      </ul>
    </section>
  );
}

/**
 * The Craft Anything dialog: Ghidra (shared with REA), deep mode for sessions, the
 * responsible-use note, install (after the acknowledgement), apply changes, update or
 * remove.
 */
export default function CraftAnythingDialog({ request, refresh, close }) {
  const craft = useCraftAnything({ request });
  const { state } = craft;
  const [draft, setDraft] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A refused change is reported below the form; bring it into view.
  const errorRef = useRef(null);
  useEffect(() => {
    if (craft.error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [craft.error]);
  // The form starts from the first state the server reports.
  useEffect(() => {
    if (state && !draft) setDraft(draftFrom(state));
  }, [state, draft]);
  // The card shows the installed version; refresh it once a job settles.
  const status = state?.status;
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current === "running" && status !== "running") void refresh?.();
    previous.current = status;
  }, [status, refresh]);
  const running = status === "running";
  const fresh = !!state && !state.serverId;
  const ready = !!state && !!draft && state.available;
  const apply = () =>
    craft.apply({
      components: { ghidra: draft.ghidra },
      settings: { mode: draft.mode },
      ...(fresh ? { confirmInstall: true } : {}),
    });
  const footer = (
    <>
      {ready && !fresh && (
        <button
          type="button"
          className="button destructive rea-uninstall"
          disabled={running}
          onClick={() => setConfirming(true)}
        >
          {copy.remove}
        </button>
      )}
      <button type="button" className="button secondary" onClick={close}>
        {commonCopy.close}
      </button>
      {ready && !fresh && state.updateAvailable && (
        <button
          type="button"
          className="button secondary"
          disabled={running}
          onClick={() => void craft.update()}
        >
          {reaCopy.update}
        </button>
      )}
      {ready && (
        <button
          type="button"
          className="button primary"
          disabled={running || (fresh && !acknowledged)}
          onClick={() => void apply()}
        >
          {running ? reaCopy.working : fresh ? commonCopy.install : reaCopy.applyChanges}
        </button>
      )}
    </>
  );
  return (
    <>
      <Modal title={copy.title} close={close} wide footer={footer} className="rea-dialog">
        <p className="dialog-hint">{copy.intro}</p>
        {craft.loading && !state && <p role="status">{copy.loading}</p>}
        {state && !state.available && (
          <p className="rea-warning">
            {serverText(state.reason, state.reasonKey, state.reasonArgs)}
          </p>
        )}
        {ready && (
          <>
            {state.updateAvailable && (
              <p className="rea-warning">{updateNote(state.components)}</p>
            )}
            {state.components.core.runningVersions?.length > 0 && (
              <p className="dialog-hint">
                {copy.runningOlder(state.components.core.runningVersions.join(", "))}
              </p>
            )}
            <Components
              components={state.components}
              draft={draft}
              onChange={setDraft}
              disabled={running}
            />
            <div className="rea-section">
              <Switch
                label={copy.deepMode}
                checked={draft.mode === "deep"}
                disabled={running}
                aria-describedby="craft-deep-hint"
                onChange={(on) =>
                  setDraft({ ...draft, mode: on ? "deep" : "clean-room" })
                }
              />
              <p id="craft-deep-hint" className="dialog-hint">
                {copy.deepModeHint}
              </p>
            </div>
            <ResponsibleUse />
            {fresh && (
              <CheckRow
                title={copy.acknowledge}
                checked={acknowledged}
                disabled={running}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
            )}
            <ToolStatus state={state} labels={statusLabels} />
          </>
        )}
        {craft.error && (
          <div ref={errorRef}>
            <ErrorMessage error={craft.error} as="p" />
          </div>
        )}
      </Modal>
      {confirming && (
        <ConfirmDialog
          title={copy.removeTitle}
          body={copy.removeBody}
          confirmLabel={commonCopy.removeNow}
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await craft.uninstall();
            setConfirming(false);
            setDraft(null);
            setAcknowledged(false);
            await refresh?.();
          }}
        />
      )}
    </>
  );
}
