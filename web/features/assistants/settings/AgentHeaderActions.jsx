import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Icon from "../../../components/Icon.jsx";
import { RowMenu, useRowMenu } from "../../extensions/RowMenu.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { agentLifecycleCopy as lifecycleCopy } from "../../../lib/i18n/messages/agent-lifecycle.js";
import { assistantSettingsCopy as copy } from "../../../lib/i18n/messages/assistant-settings.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import { isPersonal } from "./agent-settings-fields.js";
import useAgentLifecycle from "./useAgentLifecycle.js";
import AgentLifecycleDialogs from "./AgentLifecycleDialogs.jsx";
import { agentsHubRoute } from "../hub-routes.js";
import "../../extensions/extensions-hub.css";

/** "Duplizieren" opens the new agent wizard prefilled from this agent (handoff 5.3.1). */
export const duplicateRoute = (assistantId) => ({
  view: "agents",
  creating: true,
  duplicate: assistantId,
});

/** The menu entries of an agent's settings header (and its Verwalten group). */
export function manageItems({ assistant, lifecycle, navigate }) {
  const items = [];
  if (isPersonal(assistant))
    items.push({
      id: "duplicate",
      label: copy.duplicate,
      run: () => navigate(duplicateRoute(assistant.id)),
    });
  // Every agent is archived and restored; only an archived one is deleted.
  if (lifecycle.archivable)
    items.push({
      id: lifecycle.archived ? "restore" : "archive",
      label: lifecycle.archived ? lifecycleCopy.restore : lifecycleCopy.archive,
      disabled: lifecycle.busy,
      run: () => (lifecycle.archived ? lifecycle.restore() : lifecycle.archive()),
    });
  if (lifecycle.archived)
    items.push({
      id: "delete",
      label: lifecycleCopy.deletePermanently,
      disabled: lifecycle.busy,
      run: lifecycle.askDelete,
    });
  return items;
}

/**
 * The settings header's actions (handoff 5.4): open the chat, and ⋯ with Duplizieren,
 * Archivieren/Wiederherstellen and, once archived, Endgültig löschen. The owner has no
 * chat of her own on a user's own agent, and opens his own chat on a shared one.
 */
export default function AgentHeaderActions({ assistant, navigate, onOpenChat }) {
  const menu = useRowMenu();
  const lifecycle = useAgentLifecycle(assistant);
  const items = manageItems({ assistant, lifecycle, navigate });
  const mode = assistant.userAccess?.mode;
  return (
    <>
      {mode !== "own" && onOpenChat && (
        <button
          type="button"
          className="assistant-header-settings"
          aria-label={mode === "shared" ? usersCopy.openMyChat : assistantCopy.chat}
          onClick={onOpenChat}
        >
          <Icon name="arrow" />
          <span>{mode === "shared" ? usersCopy.openMyChat : assistantCopy.chat}</span>
        </button>
      )}
      {items.length > 0 && (
        <>
          <button
            type="button"
            className="assistant-header-icon"
            aria-label={commonCopy.moreActions}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
          >
            <Icon name="more" />
          </button>
          <RowMenu label={commonCopy.moreActions} state={menu} items={items} />
        </>
      )}
      <ErrorMessage error={lifecycle.error} />
      <AgentLifecycleDialogs
        assistant={assistant}
        lifecycle={lifecycle}
        onDeleted={() => navigate(agentsHubRoute())}
      />
    </>
  );
}
