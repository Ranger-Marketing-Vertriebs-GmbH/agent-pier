// The "Learns its own skills" switch of the Capabilities tab, as the server decides
// it (server/features/assistants/skill-learning.js): the agent's view carries the
// effective value (`skillLearning`) and why it is locked (`skillLearningLocked`),
// its runtime view the traits. No runtime is named here.
import { traitOf } from "../runtime-traits.js";
import { shellEligible } from "../shell-level.js";

/**
 * `shown`: the agent has settings of its own (not archived, no task member, which
 * follows its lead); `locked`: why the server refuses it learning, or null:
 * `userAgent` (an agent of users) or `channelBot` (its own bot for other people);
 * `writesWhenAsked`: with learning off it still writes a skill when asked.
 */
export const learningSwitch = (assistant) => ({
  shown: !!assistant && shellEligible(assistant),
  locked: ["userAgent", "channelBot"].includes(assistant?.skillLearningLocked)
    ? assistant.skillLearningLocked
    : null,
  writesWhenAsked: traitOf(assistant?.runtimeInfo, "skills", "writesWhenAsked"),
});
