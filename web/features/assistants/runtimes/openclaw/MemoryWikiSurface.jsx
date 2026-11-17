import React, { useId } from "react";
import GroupLabel from "../../../../components/GroupLabel.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow, { ToggleRow } from "../../../../components/ListRow.jsx";
import { routePath } from "../../../../app/routes.js";
import { assistantMemoryWikiCopy as copy } from "../../../../lib/i18n/messages/assistant-memory-wiki.js";
import { agentRoute } from "../../settings/agent-settings-fields.js";
import { wikiLock, wikiOpen, withWiki } from "./wiki-rules.js";

/**
 * The memory wiki of an OpenClaw agent (docs/agents.md): OpenClaw's built surface in
 * the slot `agent.capabilities` of the agent's Capabilities tab. The switch edits the
 * tab's draft (`runtimeOptions.openclaw.memoryWiki`) and is saved with its PATCH; it
 * stays visible but locked, with the reason, for an agent that may not keep one. A
 * link opens the read page while the saved agent keeps a wiki.
 */
export default function MemoryWikiSurface({ context }) {
  const { assistant, options, setOptions, go } = context;
  const id = useId();
  const lock = wikiLock(assistant);
  const on = !lock && options?.memoryWiki === true;
  return (
    <section aria-labelledby={id} data-surface="memoryWiki">
      <GroupLabel id={id} hint={copy.hint}>
        {copy.title}
      </GroupLabel>
      <ListCard labelledBy={id}>
        <ToggleRow
          label={copy.switch}
          sub={lock ? copy.locked[lock] : copy.description}
          checked={on}
          disabled={Boolean(lock)}
          onChange={(next) => setOptions(withWiki(options, next))}
        />
        {!lock && wikiOpen(assistant) && (
          <ListRow
            label={copy.open}
            sub={copy.openHint}
            href={routePath(agentRoute(assistant.id, "capabilities", "wiki"))}
            onClick={go ? () => go("capabilities", "wiki") : undefined}
          />
        )}
      </ListCard>
    </section>
  );
}
