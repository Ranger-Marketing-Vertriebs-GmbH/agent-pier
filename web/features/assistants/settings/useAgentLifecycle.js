import { useState } from "react";
import useAssistants from "../useAssistants.js";
import { assistantApi } from "../assistant-api.js";

const finished = ["completed", "failed", "cancelled"];

/**
 * Archive, restore and permanent delete of any agent (the settings header's ⋯ menu,
 * Overview › Manage and Agents › Archive). A team member still at work is not
 * archived; a lead with temporary members asks first (`dialog` "members"), and a
 * delete opens its confirmation (`dialog` "delete").
 */
export default function useAgentLifecycle(assistant) {
  const { members = [], refresh } = useAssistants();
  const member = members.find((m) => m.assistantId === assistant.id) || null;
  const tasks = members.filter(
    (m) =>
      m.parentAssistantId === assistant.id && m.lifetime !== "permanent" && !m.archivedAt,
  );
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return {
    archivable: !member || finished.includes(member.phase),
    archived: !!assistant.archivedAt,
    tasks,
    dialog,
    busy,
    error,
    close: () => setDialog(null),
    // `withMembers` confirms that its temporary members are archived with it.
    archive(withMembers = false) {
      if (tasks.length && !withMembers) return setDialog("members");
      setDialog(null);
      return run(() =>
        assistantApi.archiveAgent(assistant.id, assistant.revision, withMembers),
      );
    },
    restore: () => run(() => assistantApi.restoreAgent(assistant.id, assistant.revision)),
    askDelete: () => setDialog("delete"),
  };
}
