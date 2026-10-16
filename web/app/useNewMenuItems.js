import useAssistantFeature from "../features/assistants/useAssistantFeature.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";

// The two things "+ New" offers; Agent only while agents are enabled.
export default function useNewMenuItems({ launch, navigate }) {
  const { enabled } = useAssistantFeature();
  return [
    { id: "session", label: copy.newSessionItem, onSelect: () => launch() },
    ...(enabled
      ? [
          {
            id: "agent",
            label: copy.newAgentItem,
            onSelect: () => navigate({ view: "agents", creating: true }),
          },
        ]
      : []),
  ];
}
