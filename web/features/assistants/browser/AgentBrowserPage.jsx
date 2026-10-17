import React, { useEffect, useRef } from "react";
import BrowserScreen from "./BrowserScreen.jsx";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import AssistantHeader from "../AssistantHeader.jsx";
import useBrowserStream from "./useBrowserStream.js";
import "./agent-browser.css";

/**
 * The live view of an agent's own browser (/agents/:id/browser): the picture, the
 * page address, its tabs and the browser's state, and the owner's takeover: while
 * the owner holds control the agent's browser calls wait (browser-takeover.js).
 * `takeover` (from ?takeover=1) takes over as soon as the picture is live.
 */
export default function AgentBrowserPage({
  assistant,
  navigate,
  onBack,
  openNavigation,
  navigationOpen,
  takeover = false,
}) {
  const { state, image, error, select, follow, start, take, handBack, input } =
    useBrowserStream(assistant.id);
  const status = state.status;
  const control = state.control || { held: false, mine: false };
  const asked = useRef(false);
  useEffect(() => {
    if (takeover && !asked.current && status === "live" && !control.held) {
      asked.current = true;
      take();
    }
  }, [takeover, status, control.held, take]);
  const reason = status === "unavailable" && copy.liveReason[state.reason];
  return (
    <section className="assistant-detail agent-browser-page">
      <AssistantHeader
        assistant={assistant}
        variant="settings"
        subtitle={copy.liveTitle}
        navigate={navigate}
        onBack={onBack}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
      />
      <div className="agent-browser-body">
        <div className="agent-browser-bar">
          <span className={`agent-browser-status ${status}`} role="status">
            <i aria-hidden="true" />
            {copy.liveStatus[status] || status}
          </span>
          {state.tabs.length > 0 && (
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
          {state.pinned && (
            <button type="button" className="button secondary compact" onClick={follow}>
              {copy.liveFollow}
            </button>
          )}
        </div>
        {status === "live" && (
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
              <button type="button" className="button primary" onClick={handBack}>
                {copy.liveHandBack}
              </button>
            ) : (
              !control.held && (
                <button type="button" className="button primary" onClick={take}>
                  {copy.liveTakeOver}
                </button>
              )
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
              <button type="button" className="button primary" onClick={start}>
                {copy.liveStart}
              </button>
            </div>
          ) : status === "live" && image ? (
            <BrowserScreen
              image={image}
              alt={copy.livePreview(assistant.name)}
              controlling={control.mine}
              input={input}
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
        {control.mine && <p className="assistant-note">{copy.liveDialogs}</p>}
        <p className="assistant-note">{copy.livePrivacy}</p>
      </div>
    </section>
  );
}
