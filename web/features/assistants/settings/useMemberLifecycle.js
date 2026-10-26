import { useState } from "react";
import useAssistants from "../useAssistants.js";
import { assistantApi } from "../assistant-api.js";

const finished = ["completed", "failed", "cancelled"];

/**
 * A team member's lifecycle actions (stop, keep as permanent agent, archive, restore,
 * recover), shared by the Team-Mitglied group, the Verwalten group and the header
 * menu. `member` is null for an agent that is no team member.
 */
export default function useMemberLifecycle(assistant) {
  const { members = [], refresh } = useAssistants();
  const member = members.find((m) => m.assistantId === assistant.id) || null;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function act(name) {
    if (!member) return;
    setBusy(true);
    setError("");
    try {
      if (name === "recover")
        await assistantApi.recoverTeamMember(member.id, member.revision);
      else
        await assistantApi.teamAction(
          "team-members",
          member.id,
          name,
          name === "stop" ? undefined : member.revision,
        );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const active = !!member && !finished.includes(member.phase);
  return {
    member,
    active,
    // A finished member is archived or restored; a running one is stopped first.
    archivable: !!member && !active,
    archived: !!member?.archivedAt,
    busy,
    error,
    act,
  };
}
