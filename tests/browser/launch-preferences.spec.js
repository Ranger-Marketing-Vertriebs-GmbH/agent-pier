import { test, expect } from "@playwright/test";
import { openNewSession } from "../helpers/navigation.js";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture, repositoryPath } from "./projects-fixture.js";

const remembered = "Aus deiner letzten Session vorausgewählt.";
const tools = ["codex", "claude", "opencode"].map((id) => ({
  id,
  name: id,
  installed: true,
  path: `/bin/${id}`,
}));
const account = (id, tool, name) => ({ id, tool, name, kind: "local", hasSecret: false });

const hubPaths =
  /^\/api\/(repositories|memory\/projects|agentbus|pipeline-runs|pipelines)(\/|$)/;
// The projects hub fixture with three CLIs, two Claude accounts (A is the
// configured default) and a captured session launch.
async function launchFixture(page) {
  const launches = [];
  await hubFixture(page, {
    intercept: async (route, url, method) => {
      if (url.pathname === "/api/state") {
        await route.fulfill({
          json: {
            tools,
            accounts: [
              account("local-codex", "codex", "Codex"),
              account("claude-a", "claude", "Claude A"),
              account("claude-b", "claude", "Claude B"),
              account("local-opencode", "opencode", "OpenCode"),
            ],
            defaultAccountIds: { claude: "claude-a" },
            sessions: [],
            home: "/work",
          },
        });
        return true;
      }
      if (url.pathname === "/api/sessions" && method === "POST") {
        const body = route.request().postDataJSON();
        launches.push(body);
        await route.fulfill({
          status: 201,
          json: { ...body, id: `launched-${launches.length}`, status: "running" },
        });
        return true;
      }
      // The hub fixture answers what the project page needs; everything else (the
      // opened session view) goes to the test server instead of an empty object.
      if (!hubPaths.test(url.pathname)) {
        await route.fallback();
        return true;
      }
      return false;
    },
  });
  return launches;
}
const field = (page, name) => page.getByLabel(name, { exact: true });
const cliHint = (page) => page.locator("#launch-cli-remembered");
async function launchFromProject(page) {
  await page.goto(base + "/projects/m1");
  await page
    .getByRole("button", {
      name: /^(Session in agent-pier starten|Start session in agent-pier)$/,
    })
    .click();
  return page.getByRole("dialog");
}

test("a project launch preselects the CLI and account of the last session", async ({
  page,
}) => {
  const launches = await launchFixture(page);
  await page.goto(base);
  await openNewSession(page);
  const dialog = page.getByRole("dialog");
  await expect(field(page, "CLI")).toHaveValue("codex");
  await expect(cliHint(page)).toHaveCount(0);
  await field(page, "CLI").selectOption("claude");
  await expect(field(page, "Zugang")).toHaveValue("claude-a");
  await field(page, "Zugang").selectOption("claude-b");
  await dialog.getByRole("button", { name: "Session starten", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(launches[0]).toMatchObject({ tool: "claude", accountId: "claude-b" });

  await launchFromProject(page);
  await expect(field(page, "CLI")).toHaveValue("claude");
  await expect(field(page, "CLI")).toHaveAccessibleDescription(remembered);
  await expect(field(page, "Zugang")).toHaveValue("claude-b");
  await expect(field(page, "Zugang")).toHaveAccessibleDescription(remembered);
  await expect(field(page, "Arbeitsverzeichnis")).toHaveValue(repositoryPath);
  // Switching CLIs inside the dialog brings each CLI's own last access back.
  await field(page, "CLI").selectOption("codex");
  await expect(field(page, "Zugang")).toHaveValue("local-codex");
  await expect(cliHint(page)).toHaveCount(0);
  await expect(field(page, "Zugang")).not.toHaveAccessibleDescription(remembered);
  await field(page, "CLI").selectOption("claude");
  await expect(field(page, "Zugang")).toHaveValue("claude-b");
  await expect(field(page, "Zugang")).toHaveAccessibleDescription(remembered);
  // A manual choice drops the hint.
  await field(page, "Zugang").selectOption("claude-a");
  await expect(field(page, "Zugang")).not.toHaveAccessibleDescription(remembered);
  await dialog.getByRole("button", { name: "Session starten", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(launches[1]).toMatchObject({
    tool: "claude",
    accountId: "claude-a",
    cwd: repositoryPath,
  });
});

test("a removed remembered account falls back to the default account", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "agentpier.launch-preferences",
      JSON.stringify({ tool: "claude", access: { claude: "claude-deleted" } }),
    ),
  );
  await launchFixture(page);
  await launchFromProject(page);
  await expect(field(page, "CLI")).toHaveValue("claude");
  await expect(field(page, "Zugang")).toHaveValue("claude-a");
  await expect(field(page, "CLI")).toHaveAccessibleDescription(remembered);
  await expect(field(page, "Zugang")).not.toHaveAccessibleDescription(remembered);
});

test("an uninstalled or garbled memory keeps the first CLI and its default", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("agentpier-language", "en");
    localStorage.setItem(
      "agentpier.launch-preferences",
      JSON.stringify({ tool: "gemini", access: ["claude-b"] }),
    );
  });
  await launchFixture(page);
  const dialog = await launchFromProject(page);
  await expect(field(page, "CLI")).toHaveValue("codex");
  await expect(field(page, "Connection")).toHaveValue("local-codex");
  await expect(cliHint(page)).toHaveCount(0);
  await expect(dialog.getByText("Preselected from your last session.")).toHaveCount(0);
});
