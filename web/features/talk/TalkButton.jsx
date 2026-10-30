import React from "react";
import Icon from "../../components/Icon.jsx";
import { talkCopy as copy } from "../../lib/i18n/messages/talk.js";

/**
 * The agent chat header's Talk button: starts talk mode, or stops it while on. When
 * talk mode cannot work (no voice, no speech recognition, plain HTTP) it stays
 * operable but marked disabled and opens the talk bar with the reason instead.
 */
export default function TalkButton({ talk, reason, loading }) {
  const on = talk.phase !== "off";
  const label = on ? copy.stop : reason ? copy.unavailable : copy.start;
  return (
    <button
      type="button"
      className={`assistant-header-icon talk-button${on ? " active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={on}
      aria-disabled={!on && (reason || loading) ? true : undefined}
      onClick={() => {
        if (on) return talk.stop();
        if (reason) return talk.showReason(reason);
        if (!loading) talk.start();
      }}
    >
      <Icon name="talk" />
    </button>
  );
}
