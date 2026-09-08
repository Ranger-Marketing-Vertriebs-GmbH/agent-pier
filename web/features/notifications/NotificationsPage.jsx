import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { notificationCopy as copy } from "../../lib/i18n/de/notifications.js";
import useNotifications from "./useNotifications.js";
import InstallCard from "./InstallCard.jsx";
export default function NotificationsPage() {
  const state = useNotifications(),
    { resource, action } = state;
  return (
    <section>
      <div className="page-header">
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
      </div>
      <InstallCard />
      <section className="operations-card">
        <h2>{copy.pushTitle}</h2>
        <p>{copy.pushPrivacy}</p>
        {!state.supported ? (
          <p>{copy.unsupported}</p>
        ) : (
          state.permission === "denied" && <p>{copy.denied}</p>
        )}
        {resource.loading && <p>{copy.loading}</p>}
        <ErrorMessage error={resource.error || action.error} />
        {resource.data && (
          <>
            {!resource.data.enabled ? (
              <p>{copy.unavailable}</p>
            ) : (
              <>
                <p role="status">{state.active ? copy.active : copy.inactive}</p>
                <label>
                  {copy.deviceLabel}
                  <input
                    maxLength={80}
                    value={state.label}
                    onChange={(event) => state.setLabel(event.target.value)}
                    disabled={action.busy}
                  />
                </label>
                <div className="operations-actions">
                  {!state.active && (
                    <button
                      className="button primary"
                      disabled={
                        action.busy || !state.supported || state.permission === "denied"
                      }
                      onClick={state.enable}
                    >
                      {copy.enable}
                    </button>
                  )}
                  {(state.own || state.subscription) && (
                    <button
                      className="button secondary"
                      disabled={action.busy}
                      onClick={() => state.remove()}
                    >
                      {copy.disable}
                    </button>
                  )}
                  {state.active && (
                    <button
                      className="button secondary"
                      disabled={action.busy}
                      onClick={state.test}
                    >
                      {copy.test}
                    </button>
                  )}
                </div>
                {state.message && <p role="status">{state.message}</p>}
              </>
            )}
          </>
        )}
      </section>
      <section className="operations-card">
        <h2>{copy.devices}</h2>
        {!resource.loading && !resource.data?.subscriptions?.length && (
          <p>{copy.noDevices}</p>
        )}
        {resource.data?.subscriptions?.map((entry) => (
          <article className="operations-card" key={entry.id}>
            <strong>{entry.label}</strong>
            <p>{entry.createdAt}</p>
            {entry.lastFailure && (
              <p>
                {copy.lastFailure}: {entry.lastFailure}
              </p>
            )}
            {entry.deviceId !== state.deviceId && (
              <button
                className="button secondary"
                disabled={action.busy}
                onClick={() => state.remove(entry)}
              >
                {copy.remove}
              </button>
            )}
          </article>
        ))}
      </section>
    </section>
  );
}
