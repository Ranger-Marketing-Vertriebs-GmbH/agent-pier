import React, { useEffect, useId, useReducer, useRef, useState } from "react";
import Sheet from "../../../components/Sheet.jsx";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { itemRoute } from "../../accounts/accounts-items.js";
import usePackageStatus from "../usePackageStatus.js";
import ConnectStep from "./ConnectStep.jsx";
import DirectoryStep from "./DirectoryStep.jsx";
import DoneStep from "./DoneStep.jsx";
import InstallStep from "./InstallStep.jsx";
import OwnCommandStep from "./OwnCommandStep.jsx";
import PackageStep from "./PackageStep.jsx";
import PasteStep from "./PasteStep.jsx";
import RemoteStep from "./RemoteStep.jsx";
import ReviewStep from "./ReviewStep.jsx";
import SettingsStep from "./SettingsStep.jsx";
import SourceStep from "./SourceStep.jsx";
import StepIndicator from "./StepIndicator.jsx";
import useWizardGuard from "./useWizardGuard.js";
import {
  fallbackStep,
  initialWizard,
  isDirty,
  previousStep,
  resolveStep,
  wizardReducer,
} from "./wizard-state.js";
import "../mcp-servers.css";
import "../mcp-packages.css";
import "./mcp-wizard.css";

/**
 * Each step receives StepProps: { state, dispatch, go, back, headingRef, server,
 * packageStatus, data, navigate, agentsEnabled, oauth, notifyMcp, setWaiting }.
 * `go(step)` visits and navigates, `back()` returns to the previous reachable step,
 * `server` is the saved record (or null).
 */
const screens = {
  source: SourceStep,
  directory: DirectoryStep,
  paste: PasteStep,
  package: PackageStep,
  remote: RemoteStep,
  command: OwnCommandStep,
  settings: SettingsStep,
  install: InstallStep,
  review: ReviewStep,
  connect: ConnectStep,
  done: DoneStep,
};

const stepRoute = (step) =>
  itemRoute("mcp-servers", "new", step && step !== "source" ? step : undefined);

/** The new-server wizard (Accounts → MCP servers → Add MCP server). */
export default function McpWizard({
  entry,
  data,
  navigate,
  agentsEnabled,
  oauth,
  notifyMcp,
}) {
  const id = useId();
  const [state, dispatch] = useReducer(wizardReducer, undefined, initialWizard);
  const headingRef = useRef(null);
  // True while Connect waits for the install to finish ("Connect when installed").
  const [waiting, setWaiting] = useState(false);
  const step = resolveStep(state, entry.step);
  const server = state.serverId
    ? ((data.mcpServers || []).find((item) => item.id === state.serverId) ?? null)
    : null;
  const packageStatus = usePackageStatus(server?.source ? server : null, data.reloadMcp);
  // A reload or a forward move names a step this visit cannot show. A kept pasted
  // block ("Add another server") is no lost setup: its Paste step is the fallback.
  useEffect(() => {
    if (step) return;
    if (!state.path && !state.via && entry.step) dispatch({ type: "lost" });
    navigate(stepRoute(fallbackStep(state)), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => {
    if (step) headingRef.current?.focus({ preventScroll: false });
  }, [step]);
  const go = (next) => {
    dispatch({ type: "visit", step: next });
    navigate(stepRoute(next));
  };
  const back = () => {
    const before = step && previousStep(state, step);
    if (before) navigate(stepRoute(before));
  };
  const guard = useWizardGuard({
    dirty: isDirty(state) || waiting,
    stays: (request) =>
      request.next?.view === "accounts" &&
      request.next.section === "mcp-servers" &&
      request.next.item === "new",
  });
  const close = () =>
    navigate(server ? itemRoute("mcp-servers", server.id) : itemRoute("mcp-servers"));
  const Screen = step ? screens[step] : null;
  const canGoBack = Boolean(step && previousStep(state, step));
  return (
    <section className="accounts-detail mcp-wizard" aria-labelledby={`${id}-title`}>
      <header className="mcp-wizard-top">
        <button
          type="button"
          className="button secondary mcp-wizard-icon"
          aria-label={copy.back}
          disabled={!canGoBack}
          onClick={back}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <p id={`${id}-title`} className="mcp-wizard-heading">
          {server?.name || copy.newTitle}
        </p>
        <button
          type="button"
          className="button secondary mcp-wizard-icon"
          aria-label={copy.close}
          onClick={close}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="mcp-wizard-layout">
        <StepIndicator path={state.path} step={step ?? "source"} />
        <div className="mcp-wizard-content">
          {Screen && (
            <Screen
              state={state}
              dispatch={dispatch}
              go={go}
              back={back}
              headingRef={headingRef}
              server={server}
              packageStatus={packageStatus}
              data={data}
              navigate={navigate}
              agentsEnabled={agentsEnabled}
              oauth={oauth}
              notifyMcp={notifyMcp}
              setWaiting={setWaiting}
            />
          )}
        </div>
      </div>
      <Sheet
        open={guard.open}
        title={waiting ? copy.waitingTitle : copy.discardTitle}
        onCancel={guard.onCancel}
      >
        <p className="sheet-body">{waiting ? copy.waitingBody : copy.discardBody}</p>
        <div className="sheet-actions">
          <button type="button" className="button danger" onClick={guard.onDiscard}>
            {waiting ? copy.leave : copy.discard}
          </button>
          <button type="button" className="button secondary" onClick={guard.onCancel}>
            {copy.keepEditing}
          </button>
        </div>
      </Sheet>
    </section>
  );
}
