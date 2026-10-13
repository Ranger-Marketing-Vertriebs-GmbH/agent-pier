import useAssistants from "../features/assistants/useAssistants.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { extensionsPageCopy } from "../lib/i18n/messages/extensions.js";
import { operationsCopy } from "../lib/i18n/messages/operations.js";
import { settingsHubCopy } from "../lib/i18n/messages/settings.js";
import { returnRoute, routePath } from "./routes.js";
import { markReturn } from "./return-scroll.js";

function originName(origin, assistants) {
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
  if (origin.view === "extensions") return extensionsPageCopy.title;
  return commonCopy.accounts;
}

/**
 * Where a page opened through a cross-link leads back to: `{ route, label, back }`
 * from a valid `returnTo`, or null when the page was opened normally and keeps its
 * own hierarchical back. `back()` returns to the origin and its scroll position.
 */
export default function useReturnTarget(route, navigate) {
  const { assistants } = useAssistants();
  const origin = returnRoute(route);
  if (!origin) return null;
  return {
    route: origin,
    label: settingsHubCopy.backTo(originName(origin, assistants)),
    back: () => {
      markReturn(routePath(origin));
      return navigate(origin);
    },
  };
}
