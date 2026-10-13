import { unknownValue } from "../../components/ListRow.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import useAssistants, { idleAssistants } from "../assistants/useAssistants.js";

// Loaded only while agents are on; "—" until the agent host has published its state.
export default function AgentServiceStatus() {
  const assistants = useAssistants();
  if (assistants === idleAssistants) return unknownValue;
  return assistantCopy.status[assistants.runtime.availability] ?? unknownValue;
}
