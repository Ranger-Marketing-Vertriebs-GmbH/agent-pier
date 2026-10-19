import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { stdioServer } from "./mcp-cli-fixture.js";
import {
  agent,
  chooseSource,
  fits,
  openWizard,
  phone,
  primary,
  withAgents,
  wizardSetup,
  writes,
} from "./mcp-wizard-fixture.js";

const voice = () => ({
  ...stdioServer(),
  name: "voice",
  envNames: ["ELEVENLABS_MCP_BASE_PATH"],
  clis: [],
  cliStatus: {},
  cliSupport: {
    claude: { supported: false, reason: "placeholder" },
    codex: { supported: false, reason: "placeholder" },
    opencode: { supported: false, reason: "placeholder" },
  },
  users: { agents: ["Home"], clis: [] },
  agentPlaceholders: true,
  placeholders: {
    args: [],
    cwd: null,
    env: { ELEVENLABS_MCP_BASE_PATH: "{agent.attachments}/voice" },
  },
  agentFolders: [
    {
      id: "home",
      name: "Home",
      entry: "voice-1a2b3c4d",
      status: "active",
      values: [
        {
          field: "env",
          name: "ELEVENLABS_MCP_BASE_PATH",
          value: "/data/assistants/workspaces/home/attachments/voice",
        },
      ],
    },
    { id: "other", name: "Other", entry: "voice-5e6f7a8b", status: "unsafe", values: [] },
  ],
});

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the wizard offers the agent's folder for a path setting and explains it", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [agent("home", "Home")]);
      const wizard = await openWizard(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("voice");
      await wizard.getByLabel("Command").fill("uvx");
      await expect(primary(wizard)).toBeEnabled();
      await primary(wizard).click();
      await expect(
        wizard.getByText(/A path can point to each agent's own folder/),
      ).toBeVisible();
      await wizard.getByText("How agent placeholders work").click();
      await expect(
        wizard.getByText(/starts the server separately for each agent/),
      ).toBeVisible();
      await wizard.getByRole("button", { name: "Add a setting" }).click();
      const row = wizard.locator(".mcp-setting");
      await row.getByLabel("Name", { exact: true }).fill("ELEVENLABS_MCP_BASE_PATH");
      const value = row.getByLabel("Value", { exact: true });
      await value.fill("{agent.attachments}/../shared");
      await expect(row.getByRole("alert")).toContainText(
        "Use {agent.workspace} or {agent.attachments}",
      );
      await row
        .getByRole("button", {
          name: "Use the agent's attachments folder for ELEVENLABS_MCP_BASE_PATH",
        })
        .click();
      await expect(value).toHaveValue("{agent.attachments}");
      await expect(row.getByRole("alert")).toHaveCount(0);
      await expect(row.getByText("Each agent gets its own folder here.")).toBeVisible();
      // A setting that is no path gets no offer.
      await wizard.getByRole("button", { name: "Add a setting" }).click();
      const key = wizard.locator(".mcp-setting").nth(1);
      await key.getByLabel("Name", { exact: true }).fill("ELEVENLABS_API_KEY");
      await key.getByLabel("Value", { exact: true }).fill("sk-test");
      await expect(key.getByRole("button", { name: /Use the agent's/ })).toHaveCount(0);
      await fits(page);
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=review/);
      await wizard.getByRole("button", { name: "Allow and save" }).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Who may use voice?" }),
      ).toBeVisible();
      expect(writes(state)[0].body.env).toEqual({
        ELEVENLABS_MCP_BASE_PATH: "{agent.attachments}",
        ELEVENLABS_API_KEY: "sk-test",
      });
      // No coding CLI can take a server with agent placeholders.
      const claude = wizard.getByRole("switch", { name: "Claude Code" });
      await expect(claude).toBeDisabled();
      await expect(
        wizard
          .getByText(
            "Coding CLIs cannot use a server with agent placeholders; give it to agents only.",
          )
          .first(),
      ).toBeVisible();
      await expect(wizard.getByRole("switch", { name: "Home" })).toBeEnabled();
    });

    test("a wrong placeholder in an argument stops at its field", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("voice");
      await wizard.getByLabel("Command").fill("uvx");
      await expect(primary(wizard)).toBeEnabled();
      await primary(wizard).click();
      await wizard.getByText(/^Arguments and working directory/).click();
      await wizard.getByRole("button", { name: "Add an argument" }).click();
      const argument = wizard.getByLabel("Argument 1", { exact: true });
      await argument.fill("--out={agent.workspce}");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=settings/);
      await expect(argument).toHaveAttribute("aria-invalid", "true");
      await expect(
        wizard.getByText(/An argument uses an agent placeholder wrongly/),
      ).toBeVisible();
      await argument.fill("--out={agent.workspace}/voice");
      await wizard
        .getByRole("button", { name: "Use the agent's workspace as working directory" })
        .click();
      await expect(
        wizard.getByLabel(
          "Working directory (optional, absolute path or agent placeholder)",
        ),
      ).toHaveValue("{agent.workspace}");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=review/);
    });

    test("the overview shows what each agent's folders resolve to", async ({ page }) => {
      const state = await wizardSetup(page, { servers: [voice()], agents: true });
      await withAgents(page, state, [agent("home", "Home", { mcpServers: ["s1"] })]);
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      const card = page
        .locator(".accounts-detail")
        .getByRole("region", { name: "Agent folders" });
      await expect(card).toContainText("Home: in use");
      await expect(card).toContainText(
        "ELEVENLABS_MCP_BASE_PATH = /data/assistants/workspaces/home/attachments/voice",
      );
      await expect(card).toContainText(
        "Other: not started: a link or file blocks the folder",
      );
      await fits(page);
    });
  });
}
