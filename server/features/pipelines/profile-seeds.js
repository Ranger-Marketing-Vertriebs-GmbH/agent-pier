const seeds = [
  [
    "planner",
    "Planner",
    "planning",
    "Analyze the task, inspect the repository and write an actionable implementation plan with validation steps. Preserve existing work. Do not implement the plan.",
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
    "Implement the task using repository conventions. Follow an existing plan when present, add meaningful tests and run the relevant checks. Report exact changes and validation evidence.",
    true,
  ],
  [
    "code-reviewer",
    "Code Reviewer",
    "review",
    "Review the current branch and task for correctness, regressions and maintainability. Write actionable findings with file references to REVIEW.md in the stage report directory. Do not change application code.",
    true,
  ],
  [
    "security-reviewer",
    "Security Reviewer",
    "review",
    "Review the task changes for authentication, authorization, injection, secret handling and trust-boundary defects. Write reproducible findings to SECURITY.md in the stage report directory. Do not change application code.",
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
    "Build and test the application using its documented local workflow. When $AGENTPIER_PORT is set (a pipeline stage), start its servers on that port instead of the documented one (the stage owns $AGENTPIER_PORT_COUNT consecutive ports from there) and use the browser session named in $AGENTPIER_BROWSER_SESSION; otherwise use the documented ports. Inspect relevant browser and API behavior and write reproducible findings to TEST-REPORT.md in the stage report directory. Stop the servers and the browser session when you are done. Do not change application code.",
    true,
  ],
  [
    "app-tester-interactive",
    "App Tester (interactive)",
    "review",
    "Work with the user to test the application. Ask for the area to inspect, reproduce issues and report evidence. Do not change application code.",
    false,
  ],
  ["default", "Default", null, "", false],
];

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
      run: { autonomous },
    },
  }));
}

export function seedPipeline(now) {
  return {
    id: "seed-implement-review",
    name: "Implement and review",
    description:
      "Implement, review, then approve. Review failures can return to implementation twice.",
    revision: 1,
    createdAt: now,
    updatedAt: now,
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
  };
}
