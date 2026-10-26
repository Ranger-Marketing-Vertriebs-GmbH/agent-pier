import useAssistants from "../features/assistants/useAssistants.js";
import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { codingPageCopy } from "../lib/i18n/messages/coding.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { connectionsAreaCopy } from "../lib/i18n/messages/connections-area.js";
import { operationsCopy } from "../lib/i18n/messages/operations.js";
import { settingsHubCopy } from "../lib/i18n/messages/settings.js";
import { returnRoute, routePath, screenRoute } from "./routes.js";
import { markReturn } from "./return-scroll.js";

// Origins are named after the page that shows them.
function originName(address, assistants, sessions) {
  const origin = screenRoute(address);
  if (origin.view === "workspace")
    return (
      (sessions || []).find((session) => session.id === origin.sessionId)?.name ||
      artifactCopy.sessionLabel
    );
  if (origin.view === "agents")
    return (
      (origin.assistantId &&
        assistants.find((assistant) => assistant.id === origin.assistantId)?.name) ||
      assistantCopy.title
    );
  if (origin.view === "settings")
    return origin.settingsSection === "general"
      ? operationsCopy.groups[origin.settingsTab] || commonCopy.settings
      : operationsCopy.sections[origin.settingsSection] || commonCopy.settings;
  if (origin.view === "coding") return codingPageCopy.title;
  if (origin.view === "connections") return connectionsAreaCopy.title;
  return commonCopy.accounts;
}

/**
 * Where a page opened through a cross-link leads back to: `{ route, label, back }`
 * from a valid `returnTo`, or null when the page was opened normally and keeps its
 * own hierarchical back. `back()` returns to the origin and its scroll position.
 * `sessions` names a session origin (the Artifacts page opened from a session).
 */
export default function useReturnTarget(route, navigate, sessions) {
  const { assistants } = useAssistants();
  const origin = returnRoute(route);
  if (!origin) return null;
  return {
    route: origin,
    label: settingsHubCopy.backTo(originName(origin, assistants, sessions)),
    back: () => {
      markReturn(routePath(origin));
      return navigate(origin);
    },
  };
}
