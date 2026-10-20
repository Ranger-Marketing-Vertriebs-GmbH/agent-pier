import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

test.describe("parallel review groups in English", () => {
  test.use({ locale: "en-GB" });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  });

  test("the editor adds a group with members side by side and saves it", async ({
    page,
  }) => {
    const state = await pipelinesFixture(page);
    state.profiles.push({ ...state.profiles[0], id: "profile-two", name: "Security" });
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
    await page
      .getByRole("radiogroup", { name: "Member 3", exact: true })
      .getByRole("radio", { name: "Security", exact: true })
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
      "Security",
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
      "profile-two",
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
    await cards
      .nth(1)
      .getByRole("button", { name: "Restart stage · Code", exact: true })
      .click();
    const call = state.calls.find((c) => c.path === "/pipeline-runs/run-one/gate");
    expect(call.body).toEqual({ action: "retry", nodeId: "code" });
    // A chip opens its member's own stage detail.
    await chips.getByRole("button", { name: "Security · Verdict: Failed" }).click();
    await expect(detail.getByRole("heading", { name: "Security" })).toBeVisible();
    await expect(detail).toContainText("Group member");
    await expect(detail).toContainText("SQL injection");
  });
});
