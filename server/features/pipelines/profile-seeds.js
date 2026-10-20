// Shared parts of the seed roles: a stage's own ports and browser session, and the
// spec's acceptance criteria as the reference for review findings.
const PORTS =
  "When $AGENTPIER_PORT is set (a pipeline stage), start every server on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Stop the servers and the browser session when you are done.";
// Reviewers stay read-only: anything they produce goes where checkpoints never look.
const FILES =
  "Put screenshots, traces, logs and every other file you produce into the stage report directory and leave no new or changed file in the worktree.";
const CRITERIA =
  'When the run has a spec, check the change against its acceptance criteria, report the criteria you checked in "criteria" and reference the criterion a finding affects with "criterion".';

const seeds = [
  [
    "planner",
    "Planner",
    "planning",
    "Analyze the task, inspect the repository and write an actionable implementation plan with validation steps to PLAN.md in the stage report directory, and declare it. When the run has a spec, name the acceptance criteria each step serves. Preserve existing work. Do not implement the plan.",
    true,
  ],
  [
    "spec-writer",
    "Spec writer",
    "planning",
    'Write the contract for the task; do not implement it. Inspect the repository, then write spec.md in the stage report directory with these sections: "## Context" (the real files, modules and commands involved, with paths), "## Requirements", "## Acceptance criteria" (a numbered list; each criterion is one checkable outcome and ends with "Verify:" and the command or check that proves it), "## Out of scope" and "## Assumptions" (a bulleted list; start an assumption with "[product decision]" when it settles product behaviour the owner should confirm). Declare spec.md as an artifact with "role":"spec". Later stages refer to the criteria as AC1, AC2 and so on. Do not change application code.',
    true,
  ],
  [
    "implementer",
    "Implementer",
    "implementation",
    `Implement the task using repository conventions. Follow the run's spec and an existing plan when present: meet every acceptance criterion, check it with its Verify step and report each one in "criteria" with its evidence. Add meaningful tests and run the relevant checks. ${PORTS} Write the exact changes and the validation evidence to IMPLEMENTATION.md in the stage report directory and declare it.`,
    true,
  ],
  [
    "code-reviewer",
    "Code Reviewer",
    "review",
    `Review the current branch and task for correctness, regressions and maintainability. ${CRITERIA} Write actionable findings with file references to REVIEW.md in the stage report directory. ${FILES} Do not change application code.`,
    true,
  ],
  [
    "security-reviewer",
    "Security Reviewer",
    "review",
    `Review the task changes for authentication, authorization, injection, secret handling and trust-boundary defects. ${CRITERIA} If you run the application to reproduce a finding: ${PORTS} Write reproducible findings to SECURITY.md in the stage report directory. ${FILES} Do not change application code.`,
    true,
  ],
  [
    "ux-reviewer",
    "UX Reviewer",
    "review",
    `Review the change from the user's side; do not change application code. Walk through every flow the task touches: how it is reached, the order of its steps, its empty, loading, error and success states, and how a user recovers from a mistake or a failed request. Check the copy for clarity, for the product's existing wording and for every language the product supports. Check accessibility: keyboard use and focus order, names and labels of controls, contrast, and how changes are announced. Check the flows at phone width and by touch. ${PORTS} ${CRITERIA} Write reproducible findings (the steps, what you saw and what you expected) to UX-REVIEW.md in the stage report directory and declare it. ${FILES} When the change has no user-facing part, pass and say so.`,
    true,
  ],
  [
    "ui-reviewer",
    "UI Reviewer",
    "review",
    `Review how the change looks; do not change application code. First find the project's styling system (design tokens, shared components, a UI guide or a component gallery), then check the changed screens against it: colours, type, spacing, icons, the components used and their hover, focus, disabled and selected states. Flag one-off styles, colours or components where an existing one fits, layouts that break at phone, tablet or desktop width, and differences from neighbouring screens, in every theme the product has. ${PORTS} ${CRITERIA} Write findings with the file and the screen to UI-REVIEW.md in the stage report directory and declare it. ${FILES} When the change has no visible part, pass and say so.`,
    true,
  ],
  [
    "conflict-resolver",
    "Conflict Resolver",
    "maintenance",
    "Inspect and resolve existing Git conflicts while preserving both sides' intended behavior. Run relevant checks and explain decisions. Never merge a pull request or push without an explicit task instruction.",
    true,
  ],
  [
    "bug-hunter",
    "Bug Hunter",
    "refinement",
    "Investigate the reported problem, reproduce it and explain its root cause. Discuss uncertain requirements before implementing a correction.",
    false,
  ],
  [
    "app-tester",
    "App Tester",
    "review",
    `Build and test the application using its documented local workflow. When $AGENTPIER_PORT is set (a pipeline stage), start its servers on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Inspect relevant browser and API behavior. ${CRITERIA} Write reproducible findings to TEST-REPORT.md in the stage report directory. ${FILES} Stop the servers and the browser session when you are done. Do not change application code.`,
    true,
  ],
  [
    "app-tester-interactive",
    "App Tester (interactive)",
    "review",
    "Work with the user to test the application. Ask for the area to inspect, reproduce issues and report evidence. Do not change application code.",
    false,
  ],
  [
    "approver",
    "Approver",
    "review",
    'Decide whether the run can go to the owner as it is; do not change application code. Read the spec (its acceptance criteria and assumptions), the earlier stages\' verdicts including the implementer\'s result per criterion, every review and test report listed below, and the run diff (git diff against the run\'s base). Spot-check at least one acceptance criterion yourself by running or reading its Verify step, and report it in "criteria". Ask the owner with "requiresHuman":true when the change touches authentication, payments, permissions or storage rules; deploy, CI, hosting or build scripts; migrations, e-mail or production data; adds a dependency; when it rests on a spec assumption that is a product decision; or when a criterion is not met or a report finding stays open. Then put the exact question for the owner in "question" and the files to look at in "files" (repository paths). Otherwise pass with a summary of what you checked. Write your reasoning to APPROVAL.md in the stage report directory and declare it.',
    true,
  ],
  ["default", "Default", null, "", false],
];

/**
 * Role texts that earlier versions seeded, release candidates included. A stored seed
 * profile whose role is still one of these was never edited there and gets the current
 * text (see seed-migration.js). Raise SEED_REVISION with every addition.
 */
export const previousSeedRoles = {
  planner: [
    "Analyze the task, inspect the repository and write an actionable implementation plan with validation steps. Preserve existing work. Do not implement the plan.",
  ],
  implementer: [
    "Implement the task using repository conventions. Follow an existing plan when present, add meaningful tests and run the relevant checks. Report exact changes and validation evidence.",
  ],
  "code-reviewer": [
    "Review the current branch and task for correctness, regressions and maintainability. Write actionable findings with file references to REVIEW.md. Do not change application code.",
    "Review the current branch and task for correctness, regressions and maintainability. Write actionable findings with file references to REVIEW.md in the stage report directory. Do not change application code.",
    // Before reviewers were asked to leave the worktree untouched.
    'Review the current branch and task for correctness, regressions and maintainability. When the run has a spec, check the change against its acceptance criteria, report the criteria you checked in "criteria" and reference the criterion a finding affects with "criterion". Write actionable findings with file references to REVIEW.md in the stage report directory. Do not change application code.',
  ],
  "security-reviewer": [
    "Review the task changes for authentication, authorization, injection, secret handling and trust-boundary defects. Write reproducible findings to SECURITY.md. Do not change application code.",
    "Review the task changes for authentication, authorization, injection, secret handling and trust-boundary defects. Write reproducible findings to SECURITY.md in the stage report directory. Do not change application code.",
    // Before reviewers were asked to leave the worktree untouched.
    'Review the task changes for authentication, authorization, injection, secret handling and trust-boundary defects. When the run has a spec, check the change against its acceptance criteria, report the criteria you checked in "criteria" and reference the criterion a finding affects with "criterion". If you run the application to reproduce a finding: When $AGENTPIER_PORT is set (a pipeline stage), start every server on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Stop the servers and the browser session when you are done. Write reproducible findings to SECURITY.md in the stage report directory. Do not change application code.',
  ],
  "app-tester": [
    "Build and test the application using its documented local workflow. Inspect relevant browser and API behavior and write reproducible findings to TEST-REPORT.md. Do not change application code.",
    "Build and test the application using its documented local workflow. Inspect relevant browser and API behavior and write reproducible findings to TEST-REPORT.md in the stage report directory. Do not change application code.",
    "Build and test the application using its documented local workflow, but start its servers on the port in $AGENTPIER_PORT (the turn owns $AGENTPIER_PORT_COUNT consecutive ports from there) instead of the documented port, and use the browser session named in $AGENTPIER_BROWSER_SESSION. Inspect relevant browser and API behavior and write reproducible findings to TEST-REPORT.md in the stage report directory. Stop the servers and the browser session when you are done. Do not change application code.",
    "Build and test the application using its documented local workflow. When $AGENTPIER_PORT is set (a pipeline stage), start its servers on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Inspect relevant browser and API behavior and write reproducible findings to TEST-REPORT.md in the stage report directory. Stop the servers and the browser session when you are done. Do not change application code.",
    // Before reviewers were asked to leave the worktree untouched.
    'Build and test the application using its documented local workflow. When $AGENTPIER_PORT is set (a pipeline stage), start its servers on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Inspect relevant browser and API behavior. When the run has a spec, check the change against its acceptance criteria, report the criteria you checked in "criteria" and reference the criterion a finding affects with "criterion". Write reproducible findings to TEST-REPORT.md in the stage report directory. Stop the servers and the browser session when you are done. Do not change application code.',
  ],
  "ux-reviewer": [
    'Review the change from the user\'s side; do not change application code. Walk through every flow the task touches: how it is reached, the order of its steps, its empty, loading, error and success states, and how a user recovers from a mistake or a failed request. Check the copy for clarity, for the product\'s existing wording and for every language the product supports. Check accessibility: keyboard use and focus order, names and labels of controls, contrast, and how changes are announced. Check the flows at phone width and by touch. When $AGENTPIER_PORT is set (a pipeline stage), start every server on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Stop the servers and the browser session when you are done. When the run has a spec, check the change against its acceptance criteria, report the criteria you checked in "criteria" and reference the criterion a finding affects with "criterion". Write reproducible findings (the steps, what you saw and what you expected) to UX-REVIEW.md in the stage report directory and declare it. When the change has no user-facing part, pass and say so.',
  ],
  "ui-reviewer": [
    'Review how the change looks; do not change application code. First find the project\'s styling system (design tokens, shared components, a UI guide or a component gallery), then check the changed screens against it: colours, type, spacing, icons, the components used and their hover, focus, disabled and selected states. Flag one-off styles, colours or components where an existing one fits, layouts that break at phone, tablet or desktop width, and differences from neighbouring screens, in every theme the product has. When $AGENTPIER_PORT is set (a pipeline stage), start every server on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Stop the servers and the browser session when you are done. When the run has a spec, check the change against its acceptance criteria, report the criteria you checked in "criteria" and reference the criterion a finding affects with "criterion". Write findings with the file and the screen to UI-REVIEW.md in the stage report directory, put screenshots you take next to it, and declare them. When the change has no visible part, pass and say so.',
  ],
};

export function seedProfiles(now) {
  return seeds.map(([key, name, phaseKey, role, autonomous]) => ({
    id: `seed-${key}`,
    name,
    description: role,
    enabled: true,
    phaseKey,
    seedKey: key,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    config: {
      accountId: "local-claude",
      cliTool: "claude",
      models: { available: [""], default: "" },
      prompts: {
        role,
        kickoff: autonomous ? "Complete your assigned stage for the supplied task." : "",
        params: [],
      },
      permissions: { mode: "auto" },
      run: { autonomous, ...(key === "approver" ? { earlierVerdicts: true } : {}) },
    },
  }));
}

const pipelineSeeds = [
  {
    id: "seed-implement-review",
    name: "Implement and review",
    description:
      "Implement, review, then approve. Review failures can return to implementation twice.",
    graph: {
      entry: "implement",
      nodes: [
        { id: "implement", kind: "profile", profileId: "seed-implementer" },
        { id: "review", kind: "profile", profileId: "seed-code-reviewer" },
        { id: "approve", kind: "gate" },
      ],
      edges: [
        { from: "implement", to: "review", condition: "default" },
        { from: "review", to: "approve", condition: "default" },
        { from: "review", to: "implement", condition: "fail", maxIterations: 2 },
      ],
    },
  },
  {
    id: "seed-software-factory",
    name: "Software factory",
    description:
      "Write a spec, implement it, verify, review in parallel (security, code, UX, UI), let the approver decide, then open a pull request. Review failures return to the implementer twice, in its own session.",
    graph: {
      entry: "spec",
      nodes: [
        { id: "spec", kind: "profile", profileId: "seed-spec-writer" },
        { id: "implement", kind: "profile", profileId: "seed-implementer" },
        { id: "verify", kind: "verify" },
        {
          id: "review",
          kind: "parallel",
          members: [
            { id: "security", profileId: "seed-security-reviewer" },
            { id: "code", profileId: "seed-code-reviewer" },
            { id: "ux", profileId: "seed-ux-reviewer" },
            { id: "ui", profileId: "seed-ui-reviewer" },
          ],
        },
        { id: "approve", kind: "profile", profileId: "seed-approver" },
        { id: "pr", kind: "createPr" },
      ],
      edges: [
        { from: "spec", to: "implement", condition: "default" },
        { from: "implement", to: "verify", condition: "default" },
        { from: "verify", to: "review", condition: "default" },
        { from: "review", to: "approve", condition: "default" },
        {
          from: "review",
          to: "implement",
          condition: "fail",
          maxIterations: 2,
          continueSession: true,
        },
        { from: "approve", to: "pr", condition: "default" },
      ],
    },
  },
];

export function seedPipelines(now) {
  return pipelineSeeds.map((pipeline) => ({
    ...structuredClone(pipeline),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }));
}
