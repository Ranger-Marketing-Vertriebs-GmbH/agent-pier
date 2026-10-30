import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import { notificationCopy } from "../../lib/i18n/messages/notifications.js";
import { formatDeviceTime } from "./device-labels.js";
import { locale } from "../../lib/i18n/index.js";
import { usePushHealth } from "./usePushHealth.js";
import "./push-health-notice.css";

const dismissedKey = "agentpier.push-health-dismissed";

function readDismissed() {
  try {
    return sessionStorage.getItem(dismissedKey);
  } catch {
    return null;
  }
}

/** The warning a person sees, or null: no device left, or every delivery failing. */
export function pushHealthKind(health) {
  if (!health) return null;
  if (health.lost) return "lost";
  if (health.failing) return "failing";
  return null;
}

/**
 * Tells the person on their start page (and the owner in the inbox) that their
 * notifications reach no device, with the way to their notification settings. Dismissed
 * for this browser session only; it returns in the next one while the cause remains.
 */
export default function PushHealthNotice({ person, health: known, openSettings }) {
  // The owner's pages pass the workspace state's health; a user's app reads theirs.
  const read = usePushHealth(known === undefined ? person : null);
  const health = known === undefined ? read : known;
  const [dismissed, setDismissed] = useState(readDismissed);
  const kind = pushHealthKind(health);
  // A plain HTTP page cannot enable notifications, so it never asks for it.
  if (!kind || dismissed === kind || !globalThis.isSecureContext) return null;
  const copy = notificationCopy.health;
  const removed = health.removed;
  const text =
    kind === "failing"
      ? copy.failing
      : removed
        ? copy.lostRemoved(
            removed.label || notificationCopy.unnamedDevice,
            formatDeviceTime(removed.at, { locale, date: true }),
            copy.reasons[removed.reason] || copy.reasons.expired,
          )
        : copy.lost;
  const dismiss = () => {
    try {
      sessionStorage.setItem(dismissedKey, kind);
    } catch {}
    setDismissed(kind);
  };
  return (
    <div className="system-status-warning push-health-notice" role="status">
      <Icon name="info" size={16} />
      <div>
        <p>
          <strong>{copy.titles[kind]}</strong>
          {text}
        </p>
        <div className="push-health-actions">
          <button
            type="button"
            className="button secondary compact"
            onClick={openSettings}
          >
            {copy.open}
          </button>
          <button type="button" className="button secondary compact" onClick={dismiss}>
            {copy.dismiss}
          </button>
        </div>
      </div>
    </div>
  );
}
