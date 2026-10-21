import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { ToggleRow, unknownValue } from "../../components/ListRow.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";
import useNotifications from "./useNotifications.js";
import InstallGroup from "./InstallGroup.jsx";
import DeviceList from "./DeviceList.jsx";
import "./notifications.css";

function toggleSub(state) {
  if (!state.supported) return copy.unsupported;
  if (state.active) return copy.active;
  if (state.permission === "denied") return copy.denied;
  return state.own ? copy.incomplete : copy.inactive;
}

// After enabling a new device: show names on its lock screen? Never a forced change.
function LabelOffer({ state }) {
  if (!state.offer) return null;
  return (
    <div className="notification-offer" role="group" aria-labelledby="notification-offer">
      <span className="notification-offer-text">
        <span id="notification-offer" className="notification-offer-title">
          {copy.labelOffer}
        </span>
        <span>{copy.labelOfferSub}</span>
        <ErrorMessage as="span" error={state.errorFor("offer")} />
      </span>
      <span className="notification-offer-actions">
        <button
          type="button"
          className="button primary compact"
          disabled={state.action.busy}
          onClick={state.acceptOffer}
        >
          {copy.labelOfferAccept}
        </button>
        <button
          type="button"
          className="button secondary compact"
          disabled={state.action.busy}
          onClick={state.dismissOffer}
        >
          {copy.labelOfferDismiss}
        </button>
      </span>
    </div>
  );
}

function ThisDevice({ state }) {
  const { resource, action } = state;
  // On while the server knows this device, so turning it off always unregisters it.
  const on = Boolean(state.own);
  if (!resource.data)
    return (
      <ListRow label={copy.pushToggle} value={resource.loading ? unknownValue : null} />
    );
  if (!resource.data.enabled)
    return <ListRow label={copy.pushToggle} sub={copy.unavailable} />;
  return (
    <>
      <ToggleRow
        label={copy.pushToggle}
        sub={toggleSub(state)}
        checked={on}
        disabled={
          action.busy || (!on && (!state.supported || state.permission === "denied"))
        }
        onChange={(checked) => (checked ? state.enable() : state.remove())}
      />
      <div className="notification-field-row">
        <label>
          <span>{copy.deviceLabel}</span>
          <input
            maxLength={80}
            value={state.label}
            onChange={(event) => state.setLabel(event.target.value)}
            disabled={action.busy}
          />
        </label>
        {state.active && state.renamed && (
          <button
            type="button"
            className="button secondary compact"
            disabled={action.busy}
            onClick={state.enable}
          >
            {copy.saveName}
          </button>
        )}
      </div>
      <LabelOffer state={state} />
      {state.active && (
        <div className="notification-test-row">
          <button
            type="button"
            className="button secondary compact"
            disabled={action.busy}
            onClick={state.test}
          >
            {copy.test}
          </button>
          {state.message && (
            <span className="notification-test-result ok" role="status">
              {state.message}
            </span>
          )}
          <ErrorMessage
            as="span"
            className="notification-test-result error"
            error={state.errorFor("test")}
          />
        </div>
      )}
    </>
  );
}

/**
 * This device's push notices and the other devices; `base` is the notification API
 * (a restricted user's account page passes /me/notifications).
 */
export function NotificationDevices({ base }) {
  const state = useNotifications(base);
  return (
    <>
      <GroupLabel id="notifications-device" hint={copy.pushPrivacy}>
        {copy.pushTitle}
      </GroupLabel>
      <ListCard labelledBy="notifications-device">
        <ThisDevice state={state} />
      </ListCard>
      <ErrorMessage error={state.resource.error || state.errorFor("device")} />
      {state.errorFor("device") === copy.unsubscribeFailed && (
        <button
          type="button"
          className="button secondary compact notification-retry"
          disabled={state.action.busy}
          onClick={() => state.remove()}
        >
          {commonCopy.retry}
        </button>
      )}
      <DeviceList state={state} />
    </>
  );
}

export default function NotificationsPage() {
  return (
    <section className="notifications-page">
      <p className="notifications-intro">{copy.description}</p>
      <InstallGroup />
      <NotificationDevices />
    </section>
  );
}
