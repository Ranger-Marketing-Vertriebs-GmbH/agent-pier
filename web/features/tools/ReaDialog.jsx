import React, { useEffect, useRef, useState } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { reaCopy as copy } from "../../lib/i18n/messages/rea.js";
import { serverText } from "../../lib/server-messages.js";
import ReaComponents from "./ReaComponents.jsx";
import ReaOwnTools, { settingsDraft } from "./ReaOwnTools.jsx";
import useRea from "./useRea.js";

const statusLabels = {
  get running() {
    return copy.statusRunning;
  },
  get failed() {
    return copy.statusFailed;
  },
  get succeeded() {
    return copy.statusSucceeded;
  },
};

/** Ticked components: what is installed, or everything this host has before an install. */
function chosenFrom(state) {
  const { ghidra, frida } = state.components;
  return state.serverId
    ? { ghidra: ghidra.installed, frida: frida.installed }
    : { ghidra: ghidra.available, frida: frida.available };
}

/** What the update brings: Core's pinned version, the Ghidra/JDK pins, or both. */
function updateNote({ core, ghidra }) {
  const parts = [];
  if (core.outdated || !ghidra.outdated) parts.push(copy.updateCore(core.pinnedVersion));
  if (ghidra.outdated)
    parts.push(copy.updateGhidra(ghidra.pinnedVersion, ghidra.jdkPinnedVersion));
  return copy.updateNote(parts.join(", "));
}

function SafetyNotes() {
  return (
    <section className="rea-section" aria-labelledby="rea-safety">
      <h3 id="rea-safety">{copy.safetyLabel}</h3>
      <ul className="rea-notes">
        <li>{copy.safetyDualUse}</li>
        <li>{copy.safetyDisclaimer}</li>
        <li>{copy.safetyUntrusted}</li>
        <li>{copy.safetyGenuine}</li>
      </ul>
      <h3 id="rea-sandbox">{copy.sandboxLabel}</h3>
      <p className="rea-warning">{copy.sandboxNotice}</p>
      <ul className="rea-notes" aria-labelledby="rea-sandbox">
        <li>{copy.sandboxGhidra}</li>
        <li>{copy.sandboxFrida}</li>
        <li>{copy.sandboxLldb}</li>
        <li>{copy.sandboxProcesses}</li>
        <li>{copy.sandboxBridges}</li>
      </ul>
    </section>
  );
}

function Status({ state }) {
  const label = statusLabels[state.status];
  const message = serverText(state.message, state.messageKey, state.messageArgs);
  if (!label && !message) return null;
  return (
    <div className={`rea-status ${state.status}`} role="status" aria-live="polite">
      {label && <strong>{label}</strong>}
      {message && <p>{message}</p>}
      {state.status === "running" && <p className="dialog-hint">{copy.backgroundNote}</p>}
    </div>
  );
}

/**
 * The REA dialog: choose components, set your own tools, read the safety and sandbox
 * notes, install (after the acknowledgement), apply changes, update or uninstall.
 */
export default function ReaDialog({ request, refresh, close }) {
  const rea = useRea({ request });
  const { state } = rea;
  const [chosen, setChosen] = useState(null);
  const [settings, setSettings] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A refused change is reported below the form; bring it into view.
  const errorRef = useRef(null);
  useEffect(() => {
    if (rea.error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [rea.error]);
  // The form starts from the first state the server reports.
  useEffect(() => {
    if (!state || chosen) return;
    setChosen(chosenFrom(state));
    setSettings(settingsDraft(state.settings));
  }, [state, chosen]);
  // The card shows the installed version; refresh it once a job settles.
  const status = state?.status;
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current === "running" && status !== "running") void refresh?.();
    previous.current = status;
  }, [status, refresh]);
  const running = status === "running";
  const fresh = !!state && !state.serverId;
  const ready = !!state && !!chosen && state.available;
  const apply = () =>
    rea.apply({
      components: { ghidra: chosen.ghidra, frida: chosen.frida },
      settings,
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
          {copy.uninstall}
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
          onClick={() => void rea.update()}
        >
          {copy.update}
        </button>
      )}
      {ready && (
        <button
          type="button"
          className="button primary"
          disabled={running || (fresh && !acknowledged)}
          onClick={() => void apply()}
        >
          {running ? copy.working : fresh ? commonCopy.install : copy.applyChanges}
        </button>
      )}
    </>
  );
  return (
    <>
      <Modal title={copy.title} close={close} wide footer={footer} className="rea-dialog">
        <p className="dialog-hint">{copy.intro}</p>
        {rea.loading && !state && <p role="status">{copy.loading}</p>}
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
            <ReaComponents
              components={state.components}
              chosen={chosen}
              onChange={setChosen}
              disabled={running}
            />
            <ReaOwnTools settings={settings} onChange={setSettings} disabled={running} />
            <SafetyNotes />
            {fresh && (
              <CheckRow
                title={copy.acknowledge}
                checked={acknowledged}
                disabled={running}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
            )}
            <Status state={state} />
          </>
        )}
        {rea.error && (
          <div ref={errorRef}>
            <ErrorMessage error={rea.error} as="p" />
          </div>
        )}
      </Modal>
      {confirming && (
        <ConfirmDialog
          title={copy.uninstallTitle}
          body={copy.uninstallBody}
          confirmLabel={copy.uninstallConfirm}
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await rea.uninstall();
            setConfirming(false);
            setChosen(null);
            setAcknowledged(false);
            await refresh?.();
          }}
        />
      )}
    </>
  );
}
