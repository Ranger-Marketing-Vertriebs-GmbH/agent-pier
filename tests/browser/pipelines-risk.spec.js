import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";
import { inboxFixture } from "./inbox-fixture.js";

const english = (page) =>
  page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));

test("risk rules sit beside the verification steps and start from the defaults", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "verification/project-one");
  const card = page.getByRole("form", { name: "Risikoregeln" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Agenten können diese Regeln nicht ändern.");
  await expect(card).toContainText("Es gelten die Standardregeln");
  const globs = card.getByRole("textbox", { name: "Pfadmuster, eines pro Zeile" });
  await expect(globs).toHaveValue("package.json\n/.github/**");
  const dependency = card.getByRole("switch", {
    name: "Neue Abhängigkeiten brauchen eine Freigabe",
  });
  await expect(dependency).toBeChecked();
  await globs.fill("package.json\n\n  infra/**  \n");
  await dependency.click();
  // Each card saves on its own, under a name that says what it saves.
  await expect(
    page.getByRole("button", { name: "Prüfschritte speichern", exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Risikoregeln speichern", exact: true }).click();
  await expect
    .poll(() => state.risk)
    .toEqual({
      globs: ["package.json", "infra/**"],
      newDependency: false,
      enabled: true,
    });
  await expect(card).toContainText(
    "Für dieses Projekt gelten deine gespeicherten Regeln.",
  );
  // The verification steps keep their own form and save.
  expect(state.calls.some((c) => c.path === "/pipeline-verification/project-one")).toBe(
    true,
  );
});

test("unsaved risk rules ask before another project opens, in English too", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  state.projects.push({ id: "project-two", name: "Second", cwd: "/fixture/two" });
  state.risk = { globs: ["infra/**"], newDependency: false, enabled: false };
  await openPipelines(page, "verification/project-one");
  const card = page.getByRole("form", { name: "Risk rules" });
  await expect(card).toContainText("Agents cannot change these rules.");
  await expect(card).toContainText("Your saved rules apply to this project.");
  const gate = card.getByRole("switch", { name: "Risk gate", exact: true });
  await expect(gate).not.toBeChecked();
  await expect(card).toContainText("Off: runs of this project never stop");
  await card.getByRole("button", { name: "Use default rules", exact: true }).click();
  await expect(gate).toBeChecked();
  await expect(
    card.getByRole("textbox", { name: "Path patterns, one per line" }),
  ).toHaveValue("package.json\n/.github/**");
  await expect(
    card.getByRole("switch", { name: "New dependencies need approval" }),
  ).toBeChecked();
  await page
    .getByRole("navigation", { name: "Projects", exact: true })
    .getByRole("button", { name: /^Second/ })
    .click();
  const confirm = page.getByRole("dialog", { name: "Save changes?" });
  await expect(confirm).toContainText("risk rules");
  await confirm.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/verification\/project-two$/);
  expect(state.risk).toEqual({
    globs: ["package.json", "/.github/**"],
    newDependency: true,
    enabled: true,
  });
});

test("the owner turns the risk gate off for a project with an explicit save", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  await openPipelines(page, "verification/project-one");
  const card = page.getByRole("form", { name: "Risk rules" });
  await expect(card).toContainText("Using the default rules");
  await card.getByRole("switch", { name: "Risk gate", exact: true }).click();
  await expect(card).toContainText("Saving records this decision in the audit log.");
  await card.getByRole("button", { name: "Save risk rules", exact: true }).click();
  await expect
    .poll(() => state.risk)
    .toEqual({
      globs: ["package.json", "/.github/**"],
      newDependency: true,
      enabled: false,
    });
});

function riskRun(state) {
  const run = sampleRun(state);
  const node = run.nodes[0];
  node.failReason = "risk-gate";
  node.verdict = { result: "pass", summary: "All criteria met", findings: [] };
  node.riskGate = {
    at: "2026-09-07T12:05:00Z",
    sha: "b".repeat(40),
    total: 5,
    items: [
      { path: ".github/workflows/ci.yml", status: "M", rule: "/.github/**" },
      {
        path: "src/auth/util.js",
        status: "R",
        rule: "auth/**",
        renamedFrom: "src/util.js",
      },
      { path: "package.json", status: "M", dependency: "zod" },
      { path: "vendor/lib", status: "M", submodule: "c".repeat(40) },
      { assumption: "A1", text: "Guests may comment" },
    ],
  };
  run.risk = {
    approved: ["path:db/migrations/001.sql"],
    decisions: [
      {
        at: "2026-09-07T11:00:00Z",
        nodeId: "stage-one",
        decision: "approved",
        total: 1,
        items: [{ path: "db/migrations/001.sql", status: "A", rule: "migrations/**" }],
      },
    ],
  };
  run.actions = ["approve-risk", "feedback", "abort"];
  state.runs.push(run);
  return run;
}

test("a stage at the risk gate lists the matched paths and is approved as such", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  riskRun(state);
  await openPipelines(page, "runs/run-one");
  await expect(page.getByText("Risky changes need your approval").first()).toBeVisible();
  const block = page.locator(".run-stage-block").filter({
    has: page.getByRole("heading", { name: "Risky changes", exact: true }),
  });
  await expect(block).toContainText(".github/workflows/ci.yml");
  await expect(block).toContainText("Rule /.github/**");
  await expect(block).toContainText("src/auth/util.js");
  await expect(block).toContainText("Renamed from src/util.js");
  await expect(block).toContainText("New dependency zod");
  await expect(block).toContainText(`Submodule now at ${"c".repeat(12)}`);
  await expect(block).toContainText("Product decision A1");
  await expect(block).toContainText("Guests may comment");
  const approvals = page.locator(".run-stage-block").filter({
    has: page.getByRole("heading", { name: "Risk gate decisions" }),
  });
  await expect(approvals).toContainText("1 change");
  await expect(approvals).toContainText("db/migrations/001.sql");
  const approve = page.getByRole("button", { name: "Approve changes", exact: true });
  await expect(approve).toHaveClass(/primary/);
  await expect(page.getByRole("button", { name: /Override/ })).toHaveCount(0);
  await approve.click();
  await expect
    .poll(
      () => state.calls.find((call) => call.path === "/pipeline-runs/run-one/gate")?.body,
    )
    .toEqual({ action: "approve-risk" });
});

test("the inbox gate shows the risky paths and the stage's question for the owner", async ({
  page,
}) => {
  const state = await inboxFixture(page);
  const node = state.run.nodes[0];
  node.failReason = "risk-gate";
  node.riskGate = {
    items: [{ path: "migrations/002.sql", status: "A", rule: "migrations/**" }],
    total: 1,
  };
  node.verdict = {
    result: "pass",
    summary: "Ready",
    findings: [],
    question: "Darf die Migration Daten löschen?",
    files: ["migrations/002.sql"],
  };
  state.run.actions = ["approve-risk", "feedback", "abort"];
  await page.goto(baseURL + "/inbox/gate/run-one");
  await expect(
    page.getByText("Riskante Änderungen brauchen deine Freigabe"),
  ).toBeVisible();
  await expect(page.getByText("Regel migrations/**")).toBeVisible();
  await expect(page.getByText("Darf die Migration Daten löschen?")).toBeVisible();
  await expect(page.getByText("Dateien zum Ansehen")).toBeVisible();
  await page.getByRole("button", { name: "Änderungen freigeben", exact: true }).click();
  await expect
    .poll(
      () => state.calls.find((call) => call.path === "/pipeline-runs/run-one/gate")?.body,
    )
    .toEqual({ action: "approve-risk" });
});

test("the inbox gate explains a risk check that could not run before approval", async ({
  page,
}) => {
  await english(page);
  const state = await inboxFixture(page);
  const node = state.run.nodes[0];
  node.failReason = "risk-gate";
  node.riskGate = { error: true, sha: "b".repeat(40) };
  // The server's German message, as the engine stores it.
  node.failDetail =
    "Die geänderten Pfade konnten nicht mit den Risikoregeln des Projekts abgeglichen werden. Eine Freigabe setzt den Lauf ohne diese Prüfung fort.";
  state.run.actions = ["approve-risk", "abort"];
  await page.goto(baseURL + "/inbox/gate/run-one");
  await expect(
    page.getByText("Approving continues the run without this check.", { exact: false }),
  ).toBeVisible();
});

test("a profile opts in to the earlier stages' verdicts", async ({ page }) => {
  await english(page);
  const state = await pipelinesFixture(page);
  await openPipelines(page);
  await page.getByRole("button", { name: "Edit: Planer", exact: true }).click();
  const option = page.getByRole("checkbox", {
    name: "Read earlier stages' verdicts",
    exact: true,
  });
  await expect(option).not.toBeChecked();
  await option.check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      () =>
        state.calls.find((c) => c.path === "/pipeline-profiles/profile-one" && c.body)
          ?.body.config.run,
    )
    .toEqual({ autonomous: true, earlierVerdicts: true });
});

test("a completed run reopened by its publication can be published or kept as is", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  const run = riskRun(state);
  run.nodes[0].riskGate.resume = "publish";
  run.actions = ["approve-risk", "decline-risk"];
  await openPipelines(page, "runs/run-one");
  await expect(
    page.getByText("Publishing this completed run found these changes."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry with feedback" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Approve changes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Don't publish", exact: true }).click();
  await expect
    .poll(
      () => state.calls.find((call) => call.path === "/pipeline-runs/run-one/gate")?.body,
    )
    .toEqual({ action: "decline-risk" });
});
