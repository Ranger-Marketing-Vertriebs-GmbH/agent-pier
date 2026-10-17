import { test, expect } from "@playwright/test";
import { openAccountItem } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { expectNoHorizontalOverflow } from "../helpers/extensions.js";
import { packagedServer, packageSetup, writes } from "./mcp-packages-fixture.js";

const listing = (installed = []) => ({
  name: "server-x",
  version: "1.0.0",
  available: true,
  profiles: [
    { id: "local-codex", tool: "codex" },
    { id: "local-claude", tool: "claude" },
  ],
  skills: [
    {
      name: "reverse-it",
      description: "Reverse engineer a program.",
      document: "---\nname: reverse-it\n---\n<b>Steps</b>",
      files: ["SKILL.md", "guide.md"],
      size: 120,
      installed,
    },
  ],
});

test("a ready package offers its bundled skills and installs them after confirmation", async ({
  page,
}) => {
  const state = await packageSetup(page, { servers: [packagedServer("ready")] });
  state.packageSkills = listing();
  state.reply = ({ path, method }) =>
    path.endsWith("/package/skills") && method === "POST"
      ? {
          status: 201,
          json: listing([{ profileId: "local-claude", version: "1.0.0" }]),
        }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const skills = dialog.getByRole("region", { name: "Bundled skills" });
  await expect(skills.getByText("Reverse engineer a program.")).toBeVisible();
  // The SKILL.md text is shown as plain text for review.
  await skills.getByText("Show SKILL.md").click();
  await expect(skills.locator("pre")).toHaveText(/<b>Steps<\/b>/);
  await skills.getByText("2 files").click();
  await expect(skills.getByText("guide.md")).toBeVisible();
  const install = skills.getByRole("button", { name: "Install selected skills" });
  await expect(install).toBeDisabled();
  await skills.getByRole("checkbox", { name: "reverse-it" }).check();
  await skills.getByLabel("Install into CLI profile").selectOption("local-claude");
  await install.click();
  const confirm = skills.getByRole("group", { name: "Install skills?" });
  await expect(confirm.getByText("Install reverse-it into Claude Code?")).toBeVisible();
  await expect(confirm.getByText(/is not checked/)).toBeVisible();
  // Nothing is written before the owner confirms.
  expect(writes(state, "/api/mcp-servers/s1/package/skills")).toHaveLength(0);
  await confirm.getByRole("button", { name: "Install", exact: true }).click();
  await expect(skills.getByText("Installed in Claude Code (1.0.0)")).toBeVisible();
  await expect(skills.getByRole("status")).toHaveText(/Skill installed/);
  expect(writes(state, "/api/mcp-servers/s1/package/skills")[0].body).toEqual({
    profileId: "local-claude",
    names: ["reverse-it"],
    confirmInstall: true,
  });
});

test("a package without bundled skills shows no skills section", async ({ page }) => {
  await packageSetup(page, { servers: [packagedServer("ready")] });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  await expect(dialog.getByRole("region", { name: "Package" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Bundled skills" })).toHaveCount(0);
});

test("on a phone the bundled skills fit the width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await packageSetup(page, { servers: [packagedServer("ready")] });
  state.packageSkills = listing();
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  await expect(dialog.getByRole("region", { name: "Bundled skills" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("a refused install names the reason and shows the list as it is now", async ({
  page,
}) => {
  const state = await packageSetup(page, { servers: [packagedServer("ready")] });
  state.packageSkills = listing();
  state.reply = ({ path, method }) => {
    if (!path.endsWith("/package/skills") || method !== "POST") return null;
    // Meanwhile installed elsewhere: the next listing says so.
    state.packageSkills = listing([{ profileId: "local-codex", version: "1.0.0" }]);
    return { status: 409, json: { error: "This skill folder already exists." } };
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const skills = dialog.getByRole("region", { name: "Bundled skills" });
  await skills.getByRole("checkbox", { name: "reverse-it" }).check();
  await skills.getByRole("button", { name: "Install selected skills" }).click();
  await skills
    .getByRole("group", { name: "Install skills?" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await expect(skills.getByText("This skill folder already exists.")).toBeVisible();
  await expect(skills.getByText("Installed in Codex (1.0.0)")).toBeVisible();
  await expect(skills.getByRole("group", { name: "Install skills?" })).toHaveCount(0);
});
