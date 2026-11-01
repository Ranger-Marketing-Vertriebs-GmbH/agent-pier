import React, { lazy, Suspense, useMemo } from "react";
import { appCopy } from "../../lib/i18n/messages/app.js";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import useAssistants from "../assistants/useAssistants.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import { chatGone } from "../assistants/chats/chat-gone.js";
import { paneTarget } from "./pane-navigation.js";
import StalePane from "./StalePane.jsx";

const AssistantChat = lazy(() => import("../assistants/AssistantChat.jsx"));

const loading = (
  <p className="loading" role="status">
    {appCopy.workspaceLoading}
  </p>
);

/** An agent chat in a pane; another chat of the same agent opens in this pane. */
export default function ChatPane({ pane, actions, chrome }) {
  const { enabled, loading: featureLoading } = useAssistantFeature();
  const { assistants, conversations, loaded } = useAssistants();
  const { assistantId, conversationId } = pane.item;
  const assistant = assistants.find((item) => item.id === assistantId);
  const menuItems = useMemo(
    () => [
      {
        id: "open-alone",
        label: viewsCopy.openAlone,
        run: () => actions.openAlone(pane.item),
      },
    ],
    [actions, pane.item],
  );
  const navigate = (next) => {
    const target = paneTarget(pane.item, next);
    if (target.kind === "item") return actions.replaceItem(pane.key, target.item);
    if (target.kind === "local") return undefined;
    if (target.kind === "rule") return actions.openRoute(target.route);
    return actions.navigate(target.route);
  };
  if (!enabled && !featureLoading)
    return <StalePane reason="agentsOff" onRemove={chrome.close} />;
  if (loaded && !assistant)
    return <StalePane reason="agentDeleted" onRemove={chrome.close} />;
  if (chatGone({ assistant, conversationId, conversations }))
    return <StalePane reason="chatDeleted" onRemove={chrome.close} />;
  if (!assistant) return loading;
  return (
    <Suspense fallback={loading}>
      <AssistantChat
        key={conversationId}
        assistant={assistant}
        conversationId={conversationId}
        navigate={navigate}
        pane={{ ...chrome, menuItems }}
      />
    </Suspense>
  );
}
