import React from "react";
import ListRow from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { routePath } from "../../../app/routes.js";
import useMobileLayout from "../../../lib/useMobileLayout.js";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import { activityFor, headerDotTone, headerStatus } from "../assistant-status.js";
import { avatarGlyph } from "../avatar-glyph.js";
import { connectionMissing } from "../connection-state.js";

export const settingsRoute = (id, tab) => ({
  view: "agents",
  assistantId: id,
  agentSettings: true,
  ...(tab ? { agentTab: tab } : {}),
});

/**
 * One agent of the hub (handoff 5.2): avatar, name, model and status, pills for its
 * access and channels, "Chat" and "Einstellungen". Without its provider access it
 * offers "Modell wählen" (Identity) instead. A user's own agent opens its settings
 * only; a shared one offers "Meinen Chat öffnen". On phones the whole row opens the
 * settings and only the chat button stays beside it.
 */
export default function AgentRow({
  assistant: a,
  models,
  runtime,
  activity,
  pills = [],
  onOpen,
  navigate,
}) {
  const phone = useMobileLayout();
  const missing = connectionMissing(a, models);
  const status = headerStatus({
    assistant: a,
    models,
    runtime,
    entry: activityFor(activity, a.id),
    copy: assistantCopy,
  });
  const settings = settingsRoute(a.id, missing ? "identity" : "");
  const sub = a.userAccess
    ? [
        a.userAccess.mode === "own" ? usersCopy.own : usersCopy.shared,
        copy.usersCount((a.userAccess.members || []).length),
      ].join(" · ")
    : missing
      ? copy.providerMissing
      : [a.model?.modelId, status.label].filter(Boolean).join(" · ");
  const link = (route) => ({
    href: routePath(route),
    onClick: () => navigate(route),
  });
  const chatLabel = a.userAccess ? usersCopy.openMyChat : assistantCopy.chat;
  const chat = a.userAccess?.mode !== "own" && !missing;
  return (
    <ListRow
      className="agents-hub-agent"
      icon={
        <span className="agents-hub-avatar">
          <span className="assistant-avatar">{avatarGlyph(a.name)}</span>
          <StatusDot
            tone={missing ? "warning" : headerDotTone(status.tone, runtime?.availability)}
            className="agents-hub-avatar-dot"
          />
        </span>
      }
      label={a.name}
      sub={sub}
      {...(phone ? link(settings) : {})}
    >
      {phone ? (
        chat && (
          <div className="agents-hub-row-actions">
            <button
              type="button"
              className="button secondary compact"
              onClick={() => onOpen(a)}
            >
              {chatLabel}
            </button>
          </div>
        )
      ) : (
        <div className="agents-hub-row-actions">
          {pills.map((pill) => (
            <span key={pill} className="agents-hub-pill">
              {pill}
            </span>
          ))}
          {missing ? (
            <a className="button secondary compact" {...anchor(link(settings))}>
              {copy.chooseModel}
            </a>
          ) : (
            <>
              {chat && (
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={() => onOpen(a)}
                >
                  {chatLabel}
                </button>
              )}
              <a className="button secondary compact" {...anchor(link(settings))}>
                {assistantCopy.settings}
              </a>
            </>
          )}
        </div>
      )}
    </ListRow>
  );
}

// An in-app link: a plain click navigates without reloading.
function anchor({ href, onClick }) {
  return {
    href,
    onClick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      event.preventDefault();
      onClick();
    },
  };
}
