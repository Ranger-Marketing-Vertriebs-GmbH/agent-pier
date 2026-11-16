import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { ToggleRow } from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantSkillsCopy as copy } from "../../../lib/i18n/messages/assistant-skills.js";
import { agentRoute } from "./agent-settings-fields.js";
import { runtimeName } from "../runtime-capabilities.js";
import { learningSwitch } from "./skill-learning-switch.js";

/**
 * The bundled skills switched on in the draft (the row opens the skills subpage) and
 * "Learns its own skills" (skill-learning-switch.js): locked with the reason for an
 * agent of users whose runtime refuses it.
 */
export default function SkillsGroup({ assistant, draft, go }) {
  const id = useId();
  const on = draft.values.skills.length;
  const learning = learningSwitch(assistant);
  const learningSub = learning.locked
    ? copy.learning.userAgent(runtimeName(assistant))
    : `${copy.learning.description} ${
        learning.writesWhenAsked
          ? copy.learning.offStillWrites
          : copy.learning.offNoSkills
      }`;
  return (
    <section id="agent-skills" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.intro}>
        {copy.title}
      </GroupLabel>
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.row}
          value={copy.count(on)}
          href={routePath(agentRoute(assistant.id, "capabilities", "skills"))}
          onClick={() => go("capabilities", "skills")}
        />
        {learning.shown && (
          <ToggleRow
            label={copy.learning.title}
            sub={learningSub}
            checked={!learning.locked && draft.values.skillLearning === true}
            disabled={learning.locked}
            onChange={(next) => draft.set("skillLearning", next)}
          />
        )}
      </ListCard>
      {/* The shell group above already says what does not work without it. */}
      {on > 0 && draft.values.shell === "off" && (
        <p className="assistant-note">{copy.shellOff}</p>
      )}
    </section>
  );
}
