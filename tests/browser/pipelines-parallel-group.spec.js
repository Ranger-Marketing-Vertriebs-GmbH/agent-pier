import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

// A run whose parallel group has one member reported, one failed and one working.
async function groupRun(page) {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  const profile = (name) => ({ ...state.profiles[0], name });
  run.status = "running";
  run.currentNodeId = "review";
  run.actions = ["abort"];
  run.nodes = [
    { ...run.nodes[0], status: "passed" },
    {
      id: "review",
      kind: "parallel",
      members: ["security", "code", "ux"],
      concurrency: 3,
      label: "Security · Code · UX",
      status: "running",
    },
    {
      id: "security",
      group: "review",
      profileSnapshot: profile("Security"),
      status: "reported",
      verdict: {
        result: "fail",
        summary: "Injection risk",
        findings: [{ severity: "high", title: "SQL injection" }],
      },
    },
    {
      id: "code",
      group: "review",
      profileSnapshot: profile("Code"),
      status: "failed",
      failReason: "session-error",
    },
    { id: "ux", group: "review", profileSnapshot: profile("UX"), status: "running" },
  ];
  return { state, run };
}

test.describe("parallel review groups in English", () => {
  test.use({ locale: "en-GB" });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  });

  test("the editor adds a group with members side by side and saves it", async ({
    page,
  }) => {
    const state = await pipelinesFixture(page);
    state.profiles.push(
      { ...state.profiles[0], id: "profile-two", name: "Security" },
      { ...state.profiles[0], id: "profile-three", name: "UX" },
    );
    await openPipelines(page, "definitions/pipeline-one");
    await page.getByRole("button", { name: "Add parallel group", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edit stage 2" })).toBeVisible();
    for (const [member, profile] of [
      ["Member 1", "Planer"],
      ["Member 2", "Security"],
    ])
      await page
        .getByRole("radiogroup", { name: member, exact: true })
        .getByRole("radio", { name: profile, exact: true })
        .check();
    await page.getByRole("button", { name: "Add member", exact: true }).click();
    // A profile another member already runs is not offered again.
    const third = page.getByRole("radiogroup", { name: "Member 3", exact: true });
    await expect(third.getByRole("radio")).toHaveCount(1);
    await expect(third.getByRole("radio", { name: "Security" })).toHaveCount(0);
    await page
      .getByRole("radiogroup", { name: "Member 3", exact: true })
      .getByRole("radio", { name: "UX", exact: true })
      .check();
    const concurrency = page.getByRole("spinbutton", {
      name: "Members working at once",
      exact: true,
    });
    await expect(concurrency).toHaveValue("3");
    await page
      .getByRole("button", { name: "Decrease members working at once", exact: true })
      .click();
    await expect(concurrency).toHaveValue("2");
    // A loop from the group returns to the earlier profile stage.
    await page
      .getByRole("radiogroup", { name: "On failure, return to", exact: true })
      .getByRole("radio", { name: "1 · Planer", exact: true })
      .check();
    const tile = page
      .getByRole("list", { name: "Stages", exact: true })
      .getByRole("button", { name: /^Stage 2\b/ });
    await expect(tile).toContainText("Parallel group");
    await expect(tile.locator(".stage-tile-member")).toHaveText([
      "Planer",
      "Security",
      "UX",
    ]);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Edit: Entwicklungsablauf", exact: true }),
    ).toBeVisible();
    const write = state.calls.find(
      (c) => c.path === "/pipelines/pipeline-one" && c.method === "PATCH",
    );
    const group = write.body.graph.nodes.find((n) => n.kind === "parallel");
    expect(group.members.map((m) => m.profileId)).toEqual([
      "profile-one",
      "profile-two",
      "profile-three",
    ]);
    expect(group.concurrency).toBe(2);
    expect(write.body.graph.edges).toContainEqual({
      from: "plan",
      to: group.id,
      condition: "default",
    });
    expect(write.body.graph.edges.find((e) => e.condition === "fail")).toMatchObject({
      from: group.id,
      to: "plan",
      maxIterations: 2,
    });
  });

  test("the run view shows members with live verdict chips and member actions", async ({
    page,
  }) => {
    const { state, run } = await groupRun(page);
    run.memberActions = { code: ["retry", "override"] };
    state.runs.push(run);
    await openPipelines(page, "runs/run-one");
    const chips = page.getByRole("list", { name: "Members", exact: true }).first();
    await expect(chips.getByRole("button")).toHaveText([
      "Security · Verdict: Failed",
      "Code · Failed",
      "UX · Working",
    ]);
    const detail = page.locator(".run-stage-detail");
    await expect(detail.getByRole("heading", { name: "Parallel group" })).toBeVisible();
    const cards = detail.locator(".run-group-member");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText("1 finding");
    await expect(cards.nth(1)).toContainText("The session ended with an error");
    // The member's actions sit side by side in one row.
    const [restart, accept] = await cards
      .nth(1)
      .locator(".run-member-actions .button")
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
    expect(restart).toBe(accept);
    await expect(
      cards.nth(1).getByRole("button", { name: "Count as passed · Code", exact: true }),
    ).toBeVisible();
    await cards
      .nth(1)
      .getByRole("button", { name: "Restart member · Code", exact: true })
      .click();
    const call = state.calls.find((c) => c.path === "/pipeline-runs/run-one/gate");
    expect(call.body).toEqual({ action: "retry", nodeId: "code" });
    // A chip opens its member's own stage detail.
    await chips.getByRole("button", { name: "Security · Verdict: Failed" }).click();
    await expect(detail.getByRole("heading", { name: "Security" })).toBeVisible();
    await expect(detail).toContainText("Group member");
    await expect(detail).toContainText("SQL injection");
  });

  test("a group override names the members it accepts without a review", async ({
    page,
  }) => {
    const { state, run } = await groupRun(page);
    run.status = "awaiting-human";
    Object.assign(run.nodes[1], { status: "failed", failReason: "members-blocked" });
    run.nodes[4].status = "reported";
    run.nodes[4].verdict = { result: "pass", summary: "Fine", findings: [] };
    run.actions = ["retry", "override", "abort"];
    state.runs.push(run);
    await openPipelines(page, "runs/run-one");
    await page
      .locator(".run-gate-decision")
      .getByRole("button", { name: "Override and continue", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(
      "Code will count as passed without a review result.",
    );
  });
});

test.describe("parallel review groups on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("member chips are full tap targets and wrap inside the screen", async ({
    page,
  }) => {
    const { state, run } = await groupRun(page);
    run.nodes[2].profileSnapshot.name = "Security reviewer with a very long profile name";
    run.memberActions = { code: ["retry", "override"] };
    state.runs.push(run);
    await openPipelines(page, "runs/run-one");
    const chips = page.locator(".run-member-chip");
    await expect(chips).toHaveCount(3);
    for (const box of await chips.evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().toJSON()),
    )) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(390);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  });
});
