import React, { useEffect, useRef } from "react";
import BrowserScreen from "./BrowserScreen.jsx";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import useBrowserStream from "./useBrowserStream.js";
import "./agent-browser.css";

/**
 * The live view of an agent's own browser: the picture, the page address, its tabs
 * and the browser's state, and the takeover: while the viewer holds control the
 * agent's browser calls wait (browser-takeover.js). The owner's page and a user's
 * (UserBrowserPage.jsx) share it; the server decides who may watch and drive.
 * `takeover` takes over as soon as the picture is live; `onControl(mine)` reports it.
 * A view-only viewer (the owner on a user's own agent, under her opt-in) only watches:
 * no takeover, start, stop, tab choice or follow.
 */
export default function AgentBrowserView({
  assistant,
  takeover = false,
  onControl,
  privacyNote,
}) {
  const { state, image, error, select, follow, start, stop, take, handBack, input } =
    useBrowserStream(assistant.id);
  const status = state.status;
  const viewOnly = state.viewOnly === true;
  const control = state.control || { held: false, mine: false };
  const asked = useRef(false);
  const handBackButton = useRef(null);
  useEffect(() => {
    if (takeover && !viewOnly && !asked.current && status === "live" && !control.held) {
      asked.current = true;
      take();
    }
  }, [takeover, viewOnly, status, control.held, take]);
  const mine = control.mine;
  useEffect(() => {
    onControl?.(mine);
  }, [onControl, mine]);
  const reason = status === "unavailable" && copy.liveReason[state.reason];
  // Start where the browser is stopped, Stop wherever it runs (also while the
  // picture does not come).
  const runs = ["live", "connecting", "blocked"].includes(status);
  return (
    <div className="agent-browser-body">
      <div className="agent-browser-bar">
        <span className={`agent-browser-status ${status}`} role="status">
          <i aria-hidden="true" />
          {copy.liveStatus[status] || status}
        </span>
        {!viewOnly && state.tabs.length > 0 && (
          <label className="agent-browser-tabs">
            <span>{copy.liveTab}</span>
            <select
              value={state.targetId || ""}
              onChange={(event) => select(event.target.value)}
            >
              {state.tabs.map((tab) => (
                <option key={tab.targetId} value={tab.targetId}>
                  {tab.title || tab.url || tab.targetId}
                </option>
              ))}
            </select>
          </label>
        )}
        {!viewOnly && state.pinned && (
          <button type="button" className="button secondary compact" onClick={follow}>
            {copy.liveFollow}
          </button>
        )}
        {!viewOnly && runs && (
          <button type="button" className="button secondary compact" onClick={stop}>
            {copy.liveStop}
          </button>
        )}
      </div>
      {viewOnly && (
        <div className="agent-browser-takeover">
          <p role="status">{copy.liveViewOnly}</p>
        </div>
      )}
      {!viewOnly && (status === "live" || control.mine) && (
        <div className={`agent-browser-takeover${control.warning ? " warning" : ""}`}>
          <p role="status">
            {control.mine
              ? control.warning
                ? copy.liveControlWarning
                : copy.liveControlMine
              : control.held
                ? copy.liveControlOther
                : copy.liveTakeOverHint}
          </p>
          {control.mine ? (
            <button
              type="button"
              className="button primary"
              ref={handBackButton}
              onClick={handBack}
            >
              {copy.liveHandBack}
            </button>
          ) : control.held ? (
            // The owner's other device holds it: move control here.
            <button
              type="button"
              className="button secondary"
              onClick={() => take({ move: true })}
            >
              {copy.liveTakeOverHere}
            </button>
          ) : (
            <button type="button" className="button primary" onClick={() => take()}>
              {copy.liveTakeOver}
            </button>
          )}
        </div>
      )}
      {state.url && (
        <p className="agent-browser-url" title={state.url}>
          {state.url}
        </p>
      )}
      <div className="agent-browser-screen">
        {status === "stopped" ? (
          <div className="agent-browser-empty">
            <p>{copy.liveStatus.stopped}</p>
            {!viewOnly && (
              <button type="button" className="button primary" onClick={start}>
                {copy.liveStart}
              </button>
            )}
          </div>
        ) : status === "live" && image ? (
          <BrowserScreen
            image={image}
            alt={copy.livePreview(assistant.name)}
            controlling={control.mine}
            input={input}
            keyboardLabel={copy.liveKeyboard}
            onEscape={() => handBackButton.current?.focus()}
          />
        ) : (
          <p className="agent-browser-empty">
            {reason || (status === "live" ? copy.liveNoImage : copy.liveStatus[status])}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="assistant-notice">
          {error}
        </p>
      )}
      {control.mine && (
        <p className="assistant-note">
          {copy.liveDialogs} {copy.liveEscape}
        </p>
      )}
      <p className="assistant-note">{privacyNote || copy.livePrivacy}</p>
    </div>
  );
}
