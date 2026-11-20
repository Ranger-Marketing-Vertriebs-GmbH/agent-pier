import React, { useCallback, useEffect, useRef, useState } from "react";
import BrowserScreen from "./BrowserScreen.jsx";
import BrowserToolbar from "./BrowserToolbar.jsx";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import useBrowserStream from "./useBrowserStream.js";
import "./agent-browser.css";

/**
 * The live view of an agent's own browser: the picture, its toolbar (address, tabs,
 * back, forward, reload and stop; BrowserToolbar.jsx) and the browser's state, and
 * the takeover: while the viewer holds control the agent's browser calls wait
 * (browser-takeover.js) and the toolbar drives the browser. The owner's page and a user's
 * (UserBrowserPage.jsx) share it; the server decides who may watch and drive.
 * `takeover` takes over as soon as the picture is live, and starts a stopped browser
 * first (an agent's take-over request, AGENTPIER-434); `onControl(mine)` reports it.
 * A view-only viewer (the owner on a user's own agent, under her opt-in) only watches:
 * no takeover, start, stop, tab choice or follow.
 */
export default function AgentBrowserView({
  assistant,
  takeover = false,
  onControl,
  privacyNote,
}) {
  const {
    state,
    image,
    error,
    select,
    follow,
    start,
    stop,
    take,
    handBack,
    navigate,
    tab,
    input,
  } = useBrowserStream(assistant.id);
  const status = state.status;
  // Start sent, the browser not up yet: the view says so instead of "not running"
  // (a cold ?takeover=1 start takes several seconds; AGENTPIER-440).
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (status !== "stopped") setStarting(false);
  }, [status]);
  useEffect(() => {
    if (error) setStarting(false);
  }, [error]);
  const startBrowser = useCallback(() => {
    setStarting(true);
    start();
  }, [start]);
  const shown = starting && status === "stopped" ? "starting" : status;
  const viewOnly = state.viewOnly === true;
  const control = state.control || { held: false, mine: false };
  const asked = useRef(false);
  const started = useRef(false);
  const handBackButton = useRef(null);
  useEffect(() => {
    if (takeover && !viewOnly && !asked.current && status === "live" && !control.held) {
      asked.current = true;
      take();
    }
  }, [takeover, viewOnly, status, control.held, take]);
  useEffect(() => {
    if (takeover && !viewOnly && !started.current && status === "stopped") {
      started.current = true;
      startBrowser();
    }
  }, [takeover, viewOnly, status, startBrowser]);
  const mine = control.mine;
  useEffect(() => {
    onControl?.(mine);
  }, [onControl, mine]);
  const reason = status === "unavailable" && copy.liveReason[state.reason];
  // Start where the browser is stopped, Stop wherever it runs (also while the
  // picture does not come).
  const runs = ["live", "connecting", "blocked"].includes(status);
  // Stopping interrupts a turn that uses the browser or a takeover: asked first.
  const [confirmStop, setConfirmStop] = useState(false);
  const askStop = () => (state.busy || control.held ? setConfirmStop(true) : stop());
  return (
    <div className="agent-browser-body">
      <div className="agent-browser-bar">
        <span className={`agent-browser-status ${shown}`} role="status">
          <i aria-hidden="true" />
          {copy.liveStatus[shown] || shown}
        </span>
        {!viewOnly && state.pinned && (
          <button type="button" className="button secondary compact" onClick={follow}>
            {copy.liveFollow}
          </button>
        )}
        {!viewOnly && runs && (
          <button type="button" className="button secondary compact" onClick={askStop}>
            {copy.liveStop}
          </button>
        )}
        {confirmStop && (
          <ConfirmDialog
            title={copy.liveStopTitle}
            body={copy.liveStopBody}
            confirmLabel={copy.liveStop}
            focusCancel
            onCancel={() => setConfirmStop(false)}
            onConfirm={() => {
              setConfirmStop(false);
              stop();
            }}
          />
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
      {runs && (
        <BrowserToolbar
          state={state}
          controlling={control.mine}
          viewOnly={viewOnly}
          navigate={navigate}
          tab={tab}
          select={select}
        />
      )}
      {/* By the address bar, so a refused address or a failed start is in view. */}
      {error && (
        <p role="alert" className="assistant-notice">
          {error}
        </p>
      )}
      <div className="agent-browser-screen">
        {status === "stopped" ? (
          // The status line above already says it is not running (or starting).
          <div className="agent-browser-empty">
            {!viewOnly && (
              <button
                type="button"
                className="button primary"
                disabled={starting}
                onClick={startBrowser}
              >
                {starting ? copy.liveStarting : copy.liveStart}
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
            keyboardButton={copy.liveKeyboardButton}
            onEscape={() => handBackButton.current?.focus()}
          />
        ) : (
          <p className="agent-browser-empty">
            {reason || (status === "live" ? copy.liveNoImage : copy.liveStatus[status])}
          </p>
        )}
      </div>
      {control.mine && (
        <p className="assistant-note">
          {copy.liveDialogs} {copy.liveEscape}
        </p>
      )}
      <p className="assistant-note">{privacyNote || copy.livePrivacy}</p>
    </div>
  );
}
