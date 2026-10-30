import React from "react";
import Icon from "../../components/Icon.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { talkCopy as copy } from "../../lib/i18n/messages/talk.js";
import { dictationCopy } from "../../lib/i18n/messages/dictation.js";
import { connectionsRoute, connectionsRoutePath } from "../connections/routes.js";
import { phaseTone, talkNotice } from "./talk-state.js";
import "./talk.css";

const setupHref = connectionsRoutePath(connectionsRoute("services", "speech"));
// Notices whose fix is in the speech settings.
const setupCodes = new Set(["notConfigured", "voiceMissing", "auth", "quota", "unknown"]);

/**
 * Talk mode's compact bar inside the agent chat, above the composer: a status dot with
 * Listening / Thinking / Speaking, the words heard so far, and Stop. Tapping the bar
 * pauses and resumes. Without a session it shows the last notice (why talk mode is
 * unavailable, or why it ended) until closed.
 */
export default function TalkBar({ talk }) {
  const { phase, heard, notice } = talk;
  const on = phase !== "off";
  if (!on && !notice) return null;
  const text = talkNotice(notice, copy, dictationCopy);
  const { tone, pulse } = phaseTone(phase);
  const paused = phase === "paused";
  return (
    <div className="talk-bar" role="region" aria-label={copy.bar}>
      {on && (
        <div className="talk-bar-row">
          <button
            type="button"
            className="talk-bar-toggle"
            aria-label={paused ? copy.resume : copy.pause}
            disabled={phase === "starting"}
            onClick={talk.toggle}
          >
            <StatusDot tone={tone} pulse={pulse} />
            <span className="talk-bar-state" role="status">
              {copy.phases[phase]}
            </span>
            {paused && <span className="talk-bar-hint">{copy.pausedHint}</span>}
            {heard && phase === "listening" && (
              <span className="talk-bar-heard">{heard}</span>
            )}
          </button>
          <button type="button" className="button secondary compact" onClick={talk.stop}>
            <Icon name="stop" size={13} fill />
            {copy.stopButton}
          </button>
        </div>
      )}
      {text && (
        <div
          className="talk-bar-notice"
          role={notice.source === "reason" ? "status" : "alert"}
        >
          <span>{text}</span>
          {setupCodes.has(notice.code) && <a href={setupHref}>{copy.setup}</a>}
          <button
            type="button"
            className="icon-button"
            aria-label={copy.close}
            onClick={talk.dismiss}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
