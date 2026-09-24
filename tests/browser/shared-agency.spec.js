import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  expectNoHorizontalOverflow,
  openTab,
  profileList,
  revealRow,
} from "../helpers/extensions.js";
const revision = "a".repeat(40);
async function fixture(page) {
  const writes = [];
  const state = {
    home: "/fixture",
    sharedCliExtensions: true,
    tools: [{ id: "claude", installed: true }],
    sessions: [],
    accounts: [
      { id: "local-claude", tool: "claude", name: "Local", kind: "local" },
      { id: "work", tool: "claude", name: "Work", kind: "managed" },
      { id: "local-codex", tool: "codex", name: "Codex", kind: "local" },
    ],
  };
  const installed = [];
  const agencyReads = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      endpoint = url.pathname;
    let result = {};
    if (request.method() !== "GET")
      writes.push({
        path: endpoint,
        body: request.postDataJSON(),
        method: request.method(),
      });
    if (endpoint === "/api/state") result = state;
    else if (endpoint.endsWith("/extensions"))
      result = {
        sharing: { shared: true, conflicts: [] },
        mcp: { servers: [], note: "Shared", path: "/fixture/.claude.json" },
        skills: { items: [], note: "Shared", installPath: "/fixture/.claude/skills" },
      };
    else if (endpoint.endsWith("/extensions/share")) result = { shared: true };
    else if (endpoint.endsWith("/plugins"))
      result = {
        available: true,
        capabilities: { marketplaces: true, install: true },
        installed: [],
        marketplaces: [],
        catalog: [],
      };
    else if (endpoint.endsWith("/agency/preview"))
      result = {
        id: "engineering__frontend",
        name: "Frontend Expert",
        description: "Accessible frontend code",
        body: "# Frontend\nUse the selected project.",
        revision,
        source:
          "https://github.com/msitarzewski/agency-agents/blob/" +
          revision +
          "/engineering/frontend.md",
      };
    else if (endpoint.endsWith("/agency")) {
      if (request.method() === "GET") agencyReads.push(url.search);
      if (request.method() === "POST")
        installed.push({
          id: "engineering__frontend",
          name: "Frontend Expert",
          revision,
          source: "https://github.com/msitarzewski/agency-agents",
        });
      result = {
        revision,
        categories: ["engineering", "testing"],
        items: [
          {
            id: "engineering__frontend",
            name: "frontend",
            category: "engineering",
            installed: Boolean(installed.length),
          },
        ],
        installed,
        total: 1,
        page: 1,
        hasMore: false,
      };
    } else if (endpoint.includes("/agency/") && request.method() === "DELETE")
      installed.length = 0;
    else throw Error("Unexpected fixture route: " + endpoint);
    await route.fulfill({ json: result });
  });
  return { writes, agencyReads };
}
for (const mobile of [false, true])
  test(`CLI groups normalize old account links and install a previewed Agency agent (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const { writes, agencyReads } = await fixture(page);
    await page.goto(baseURL + "/extensions/work");
    await expect(page).toHaveURL(/extensions\/local-claude$/);
    const profiles = profileList(page).getByRole("button");
    await expect(profiles).toHaveCount(2);
    await expect(profiles.filter({ hasText: "Claude Code" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(page.getByRole("tab")).toHaveText([
      /^MCP-Server/,
      /^Skills/,
      /^Plugins/,
      /^Marketplaces/,
      /^Agenten/,
    ]);
    await page
      .getByRole("button", { name: "Vorhandene Account-Konfigurationen übernehmen" })
      .click();
    await expect(
      page.getByText("Vorhandene Erweiterungen wurden zusammengeführt."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Agency Agents" })).toHaveCount(0);
    expect(agencyReads).toEqual([]);
    await openTab(page, "Agenten");
    await expect(page).toHaveURL(/extensions\/local-claude\?tab=agents$/);
    await expect(
      page.getByText("Installierte Agenten gelten für alle Accounts dieser CLI."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Katalog durchsuchen", exact: true }).click();
    await expect(page.getByRole("radio", { name: /^Katalog/ })).toBeChecked();
    await page.getByLabel("Agency-Agenten suchen").fill("frontend");
    await expect(
      page.getByRole("heading", { name: "frontend", exact: true }),
    ).toBeVisible();
    await revealRow(page, "frontend");
    await page.getByRole("button", { name: "Agent ansehen" }).click();
    const dialog = page.getByRole("dialog", { name: "Frontend Expert" });
    await expect(dialog).toContainText("Use the selected project.");
    await expect(dialog).toContainText(
      "Modell und Berechtigungen werden von deiner Sitzung geerbt.",
    );
    await expect(dialog.getByRole("link", { name: /Quelle auf GitHub/ })).toBeVisible();
    await page.screenshot({
      path: `/tmp/agentpier-agency-preview-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "Für diese CLI installieren" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Agent installiert. Starte eine neue Sitzung, um ihn zu verwenden."),
    ).toBeVisible();
    expect(writes.find((item) => item.path.endsWith("/agency")).body).toEqual({
      id: "engineering__frontend",
      revision,
    });
    await page.getByRole("radio", { name: /^Installiert/ }).check();
    await revealRow(page, "Frontend Expert");
    await page.getByRole("button", { name: "Agent entfernen", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Agent entfernen", exact: true })
      .click();
    await expect(page.getByText("Agency-Agent entfernt.", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("radio", { name: /^Katalog/ }).check();
    await revealRow(page, "frontend");
    await expect(page.getByRole("button", { name: "Agent ansehen" })).toBeVisible();
    await page.screenshot({
      path: `/tmp/agentpier-agency-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
  });
