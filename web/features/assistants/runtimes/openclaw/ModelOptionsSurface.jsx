import React, { useId } from "react";
import GroupLabel from "../../../../components/GroupLabel.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow, { SelectRow, ToggleRow } from "../../../../components/ListRow.jsx";
import { assistantAdvancedCopy } from "../../../../lib/i18n/messages/assistant-advanced.js";
import { assistantModelOptionsCopy as copy } from "../../../../lib/i18n/messages/assistant-model-options.js";
import {
  fastChoice,
  fastValue,
  followsLead,
  loopChecked,
  thinkingChoice,
  thinkingLevels,
  withLoop,
  withOption,
} from "./model-option-rules.js";

/**
 * How an OpenClaw agent's model works (docs/agents.md): OpenClaw's built surface in
 * the slot `agent.identity`, below the model on the agent's Identity tab. The rows
 * edit the tab's draft (`runtimeOptions.openclaw.thinking`, `.fastMode` and
 * `.loopDetection`) and are saved with its PATCH; "Default" stores nothing, and the
 * loop protection switch shows the automatic rule for the drafted model
 * (`context.connection`) until the owner chooses against it. A temporary team member
 * shows that it follows its lead instead.
 */
export default function ModelOptionsSurface({ context }) {
  const { assistant, options, setOptions, connection } = context;
  const id = useId();
  const levels = assistantAdvancedCopy.settings.thinkingDefault.options;
  const inherit = { value: "", label: copy.inherit };
  return (
    <section aria-labelledby={id} data-surface="modelOptions">
      <GroupLabel id={id} hint={copy.hint}>
        {copy.title}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {followsLead(assistant) ? (
          <ListRow label={copy.member.label} sub={copy.member.sub} />
        ) : (
          <>
            <SelectRow
              label={copy.thinking.label}
              sub={copy.thinking.sub}
              value={thinkingChoice(options)}
              options={[
                inherit,
                ...thinkingLevels.map((level) => ({
                  value: level,
                  label: levels[level],
                })),
              ]}
              onChange={(value) =>
                setOptions(withOption(options, "thinking", value || undefined))
              }
            />
            <SelectRow
              label={copy.fast.label}
              sub={copy.fast.sub}
              value={fastChoice(options)}
              options={[
                inherit,
                { value: "on", label: copy.fast.on },
                { value: "off", label: copy.fast.off },
              ]}
              onChange={(value) =>
                setOptions(withOption(options, "fastMode", fastValue(value)))
              }
            />
            <ToggleRow
              label={copy.loop.label}
              sub={copy.loop.sub}
              checked={loopChecked(options, connection)}
              onChange={(next) => setOptions(withLoop(options, next, connection))}
            />
          </>
        )}
      </ListCard>
    </section>
  );
}
