import { requestCopy as copy } from "../../lib/i18n/de/requests.js";

export const planLimit = 100000;
const ruleLimit = 20;
const toolPattern = /^[A-Za-z0-9_.:-]{1,200}$/;

/** A permission rule as Claude writes it in settings: `Bash(npm test:*)`. */
export const ruleText = (rule) =>
  rule.ruleContent === undefined
    ? rule.toolName
    : `${rule.toolName}(${rule.ruleContent})`;

/**
 * Claude's own "don't ask again" proposals for this call, reduced to allow rules.
 * Mode switches and directory grants are left to Claude's own dialog.
 */
export function persistentRules(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  const rules = new Map();
  for (const suggestion of suggestions) {
    if (
      suggestion?.type !== "addRules" ||
      suggestion.behavior !== "allow" ||
      !Array.isArray(suggestion.rules)
    )
      continue;
    for (const rule of suggestion.rules) {
      if (typeof rule?.toolName !== "string" || !toolPattern.test(rule.toolName))
        continue;
      const content = rule.ruleContent;
      if (
        content !== undefined &&
        (typeof content !== "string" ||
          !content.trim() ||
          content.length > 2000 ||
          content.includes("\0"))
      )
        continue;
      const value = {
        toolName: rule.toolName,
        ...(content === undefined ? {} : { ruleContent: content }),
      };
      rules.set(ruleText(value), value);
    }
  }
  return rules.size > ruleLimit ? [] : [...rules.values()];
}

/**
 * Persisted rules go to Claude's user settings, which live in the account's own
 * CLAUDE_CONFIG_DIR. Project destinations (`localSettings`, `projectSettings`) are
 * shared by every account that opens the same folder, so they are never used.
 */
export const alwaysDecision = (rules) => ({
  behavior: "allow",
  updatedPermissions: [
    { type: "addRules", rules, behavior: "allow", destination: "userSettings" },
  ],
});

// Model-facing text stays English like Claude's own tool results.
const keepPlanning =
  "The user reviewed this plan in AgentPier chat and wants to keep planning. " +
  "Stay in plan mode and do not implement anything yet; wait for the user's feedback.";
const planDecisions = {
  // Like Claude's own dialog: leaving plan mode sets the mode for the rest of
  // the session, never a persisted default.
  acceptEdits: {
    behavior: "allow",
    updatedPermissions: [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
  },
  approve: {
    behavior: "allow",
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
  },
  keep: { behavior: "deny", message: keepPlanning, interrupt: true },
};

/** ExitPlanMode: show the plan itself and Claude's three answers. */
export function planRequest(data) {
  const plan = data.tool_input?.plan;
  if (typeof plan !== "string" || !plan.trim()) return null;
  return {
    view: {
      kind: "permission",
      subject: {
        tool: data.tool_name,
        plan: plan.slice(0, planLimit),
        cwd: data.cwd,
      },
      options: [
        { id: "acceptEdits", label: copy.planAcceptEdits, scope: "session" },
        { id: "approve", label: copy.planApprove, scope: "session" },
        { id: "keep", label: copy.planKeep },
      ],
    },
    answer: (input) =>
      input.handoff
        ? null
        : {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: planDecisions[input.choice],
            },
          },
  };
}
