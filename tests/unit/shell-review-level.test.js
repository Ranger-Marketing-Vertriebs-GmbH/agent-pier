import test from "node:test";
import assert from "node:assert/strict";
import {
  askingShellLevels,
  personalShell,
  profileTools,
  shellLevels,
} from "../../server/features/assistants/native-capabilities.js";
import { agentExec } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/shell.js";
import { shellChange } from "../../server/features/assistants/shell-changes.js";
import { memberInheritance } from "../../server/features/assistants/member-grants.js";
import {
  effectiveRights,
  hookDefaults,
  rightsInput,
  shellChoices as hookShellChoices,
} from "../../server/features/assistants/agent-hook-rights.js";
import {
  approvalRunSeconds,
  hookRunSeconds,
} from "../../server/features/assistants/agent-hook-runs.js";
import { routineTimeoutSeconds } from "../../server/features/assistants/native-routines.js";
import { assistantBootstrap } from "../../server/features/assistants/assistant-bootstrap.js";
import { refuseEveryCommand } from "../../server/features/assistants/own-process-agents.js";
import { validateDefinition } from "../../server/features/assistants/assistant-validation.js";
import { traitOf } from "../../server/features/assistants/runtimes/runtime-descriptors.js";
import { shellLevel as hermesShellLevel } from "../../server/features/assistants/runtimes/hermes/hermes-config/tools.js";
import { telegramEligible } from "../../server/features/assistant-channels/telegram-inputs.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import {
  offersReview,
  shellChoices,
  shellLevel,
} from "../../web/features/assistants/shell-level.js";
import { withRuntime } from "../../web/features/assistants/wizard/wizard-draft.js";
import { confirmationRequest } from "../../web/lib/settings/save-chain.js";

// The model-reviewed shell level "review" (docs/assistant-shell-qualification.md (i)):
// between "approval" and "full", OpenClaw's exec mode "auto", offered only by a
// runtime whose trait names it.
const hermes = { runtime: "hermes" };
const refusal = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};

test("review ranks between approval and full and may ask the owner", () => {
  assert.deepEqual(shellLevels, ["off", "approval", "review", "full"]);
  assert.deepEqual(askingShellLevels, ["approval", "review"]);
  assert.deepEqual(validateDefinition({ shell: "review" }, true), { shell: "review" });
});

test("review compiles to OpenClaw's auto mode with strict inline evaluation", () => {
  assert.deepEqual(agentExec("review", ["/owner/bin"]), {
    mode: "auto",
    strictInlineEval: true,
    pathPrepend: ["/owner/bin"],
  });
  // No reviewer override: OpenClaw reviews on the agent's own model and login.
  assert.equal("reviewer" in agentExec("review"), false);
  assert.deepEqual(agentExec("review"), { mode: "auto", strictInlineEval: true });
});

test("raising to review needs the shell warning and its own confirmation", () => {
  const agent = (shell) => ({ id: "a", shell });
  const required = (from, to, confirmations) =>
    refusal(() => shellChange(agent(from), { shell: to }, confirmations))?.required;
  assert.deepEqual(required("off", "review"), ["confirmShell", "confirmReview"]);
  assert.deepEqual(required("approval", "review", { confirmShell: true }), [
    "confirmReview",
  ]);
  // Full access is confirmed by its own flag, never by the review's.
  assert.deepEqual(
    required("review", "full", { confirmShell: true, confirmReview: true }),
    ["confirmFull"],
  );
  assert.deepEqual(required("approval", "review", { confirmFull: true }), [
    "confirmShell",
    "confirmReview",
  ]);
  const missing = refusal(() =>
    shellChange(agent("approval"), { shell: "review" }, { confirmShell: true }),
  );
  assert.equal(missing.status, 409);
  assert.equal(missing.key, "shellReviewConfirmationRequired");
  assert.deepEqual(
    shellChange(
      agent("approval"),
      { shell: "review" },
      { confirmShell: true, confirmReview: true },
    ),
    { from: "approval", to: "review", raised: true },
  );
  // Lowering never asks.
  assert.deepEqual(shellChange(agent("full"), { shell: "review" }), {
    from: "full",
    to: "review",
    raised: false,
  });
  assert.deepEqual(shellChange(agent("review"), { shell: "approval" }), {
    from: "review",
    to: "approval",
    raised: false,
  });
});

test("agents of users and of other people never get the reviewed level", () => {
  const user = { id: "u", shell: "review", userAccess: { mode: "own", members: [] } };
  assert.equal(personalShell(user), "off");
  assert.equal(profileTools(user, true, true).includes("exec"), false);
  // A bot for other people needs shell off, whatever the level.
  assert.equal(telegramEligible({ id: "a", runtimeAgentId: "ap-a", shell: "off" }), true);
  assert.equal(
    telegramEligible({ id: "a", runtimeAgentId: "ap-a", shell: "review" }),
    false,
  );
  assert.equal(shellLevel({ shell: "review", archivedAt: "x" }), "off");
});

test("a temporary member runs at most at its lead's level", () => {
  const lead = (shell, extra = {}) => ({ id: "l", shell, capabilities: {}, ...extra });
  const level = (leadShell, grant, extra) =>
    memberInheritance(lead(leadShell, extra), { shell: grant }, true).shell;
  assert.equal(level("review", "review"), "review");
  assert.equal(level("review", "full"), "review");
  assert.equal(level("full", "review"), "review");
  assert.equal(level("approval", "review"), "approval");
  assert.equal(level("review", "approval"), "approval");
  assert.equal(
    memberInheritance(lead("review"), { shell: "review" }, false).shell,
    "off",
  );
  // On a runtime without the level the member falls to the next lower one it has.
  assert.equal(level("full", "review", hermes), "approval");
  assert.equal(level("full", "full", hermes), "full");
  const member = {
    id: "m",
    teamMemberId: "t",
    inherited: { shell: "review", capabilities: {}, skills: [] },
  };
  assert.equal(personalShell(member), "review");
});

test("a hook runs at the agent's level or not at all", () => {
  assert.deepEqual(hookShellChoices("review"), ["off", "review"]);
  assert.deepEqual(hookShellChoices("sudo"), ["off"]);
  const ceiling = { ...hookDefaults, shell: "review", sshHosts: [], folders: {} };
  assert.equal(rightsInput({ shell: "review" }, ceiling).shell, "review");
  assert.equal(refusal(() => rightsInput({ shell: "full" }, ceiling)).status, 400);
  const effective = (saved, level) =>
    effectiveRights(
      { ...hookDefaults, shell: saved },
      { shell: level, sshHosts: [], folders: {} },
    ).shell;
  // Saved above the agent's level: the agent's lower level.
  assert.equal(effective("full", "review"), "review");
  assert.equal(effective("full", "approval"), "approval");
  assert.equal(effective("review", "approval"), "approval");
  assert.equal(effective("review", "review"), "review");
  // Saved below it: exec is set per agent, so the run would be laxer. Fail closed.
  assert.equal(effective("approval", "review"), "off");
  assert.equal(effective("review", "full"), "off");
  assert.equal(effective("approval", "full"), "off");
  assert.equal(effective("review", "off"), "off");
  assert.equal(effective("full", "off"), "off");
});

test("a hook run that may ask the owner has the approval budget", () => {
  assert.equal(hookRunSeconds({ shell: "review" }, {}), approvalRunSeconds);
  assert.equal(hookRunSeconds({ shell: "approval" }, {}), approvalRunSeconds);
  assert.equal(hookRunSeconds({ shell: "full" }, {}), routineTimeoutSeconds);
  assert.equal(hookRunSeconds({ shell: "review" }, hermes), routineTimeoutSeconds);
});

test("the agent is told what the reviewer's verdicts mean", () => {
  const text = (shell) =>
    assistantBootstrap({ id: "a", name: "A", shell, capabilities: {} }, {});
  assert.match(text("review"), /Exec denied by auto-review/);
  assert.match(text("review"), /SYSTEM_RUN_DENIED/);
  assert.equal((text("review").match(/^## Shell$/gm) || []).length, 1);
  assert.doesNotMatch(text("approval"), /auto-review/);
  assert.doesNotMatch(text("full"), /auto-review/);
});

test("only a runtime that names the level offers it", () => {
  assert.equal(traitOf({}, "approvals", "shellLevels").includes("review"), true);
  assert.equal(traitOf(hermes, "approvals", "shellLevels").includes("review"), false);
  const refused = refusal(() => refuseEveryCommand(null, hermes, { shell: "review" }));
  assert.equal(refused.status, 400);
  assert.equal(refused.key, "shellLevelUnsupported");
  for (const shell of ["off", "approval", "full"])
    assert.equal(
      refusal(() => refuseEveryCommand(null, hermes, { shell })),
      null,
    );
  assert.equal(
    refusal(() => refuseEveryCommand(null, {}, { shell: "review" })),
    null,
  );
  // A stored level Hermes does not have compiles to no shell at all.
  assert.equal(
    hermesShellLevel({ shell: { level: "review" }, runtimeAgentId: "ap-h" }),
    "off",
  );
});

test("a level change to or from review is audited by name", () => {
  const event = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "a",
    source: "user",
    outcome: "success",
    details: { kind: "shell", shellFrom: "approval", shellTo: "review" },
  });
  assert.equal(event.details.shellFrom, "approval");
  assert.equal(event.details.shellTo, "review");
});

test("the picker offers the level where the runtime view names it", () => {
  const hermesInfo = {
    id: "hermes",
    name: "Hermes Agent",
    capabilities: {
      approvals: { available: true, shellLevels: ["off", "approval", "every", "full"] },
    },
  };
  assert.deepEqual(shellChoices(undefined), ["off", "approval", "review", "full"]);
  assert.deepEqual(shellChoices(hermesInfo), ["off", "approval", "every", "full"]);
  assert.equal(offersReview(undefined), true);
  assert.equal(offersReview(hermesInfo), false);
  assert.equal(shellLevel({ shell: "review" }), "review");
  // The wizard takes the level back when the chosen runtime lacks it.
  assert.equal(
    withRuntime({ shell: "review" }, "hermes", [], hermesInfo).shell,
    "approval",
  );
  assert.equal("shell" in withRuntime({ shell: "review" }, "openclaw", [], {}), false);
});

test("the review's confirmation has its own dialog", () => {
  assert.deepEqual(
    confirmationRequest({
      code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
      required: ["confirmReview"],
    }),
    {
      kind: "reviewShell",
      flags: { confirmReview: true },
      data: { required: ["confirmReview"] },
    },
  );
  assert.equal(
    confirmationRequest({
      code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
      required: ["confirmShell", "confirmReview"],
    }).kind,
    "shell",
  );
});
