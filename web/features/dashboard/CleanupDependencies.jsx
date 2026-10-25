import React from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { CLEANUP_API, cleanupSize, useCleanup } from "./useCleanup.jsx";

/** Per agent: the node_modules folders in its workspace and their size. */
export default function CleanupDependencies() {
  const text = copy.cleanup.dependencies;
  const { data, confirm, feedback } = useCleanup("dependencies");
  const agents = (Array.isArray(data?.agents) ? data.agents : []).filter(
    (agent) => agent.folders > 0,
  );
  return (
    <>
      {feedback}
      {data && !agents.length && <p className="hint">{text.empty}</p>}
      {agents.length > 0 && (
        <ListCard label={text.label}>
          {agents.map((agent) => {
            const name = agent.name || text.removedAgent;
            const size = cleanupSize(agent.bytes, agent.partial);
            return (
              <ListRow
                key={agent.id}
                label={name}
                sub={agent.working ? text.working : text.folders(agent.folders)}
                value={size}
                disabled={agent.working}
                deleteLabel={text.deleteLabel(name)}
                onDelete={() =>
                  confirm({
                    title: text.confirmTitle(name),
                    body: [text.confirmBody(agent.folders, size), text.confirmWarning],
                    confirmLabel: text.confirm,
                    path: `${CLEANUP_API}/dependencies/${encodeURIComponent(agent.id)}`,
                    method: "DELETE",
                  })
                }
              />
            );
          })}
        </ListCard>
      )}
    </>
  );
}
