import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
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
  return writes;
}
for (const mobile of [false, true])
  test(`CLI groups normalize old account links and install a previewed Agency agent (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const writes = await fixture(page);
    await page.goto(baseURL + "/extensions/work");
    await expect(page).toHaveURL(/extensions\/local-claude$/);
    const cli = page.getByRole("combobox", { name: "CLI", exact: true });
    await expect(cli.locator("option")).toHaveCount(2);
    await page
      .getByRole("button", { name: "Vorhandene Kontokonfigurationen übernehmen" })
      .click();
    await expect(
      page.getByText("Vorhandene Erweiterungen wurden zusammengeführt."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Agency Agents", exact: true }).click();
    await page.getByLabel("Agency-Agenten suchen").fill("frontend");
    await page.getByRole("button", { name: "Agent ansehen" }).click();
    const dialog = page.getByRole("dialog", { name: "Frontend Expert" });
    await expect(dialog).toContainText("Use the selected project.");
    await expect(dialog).toContainText(
      "Modell und Berechtigungen werden von deiner Sitzung geerbt.",
    );
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
    await page.getByRole("button", { name: "Agent entfernen", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Agent entfernen", exact: true })
      .click();
    await expect(page.getByText("Agency-Agent entfernt.", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expect(page.getByRole("button", { name: "Agent ansehen" })).toBeVisible();
    await page.screenshot({
      path: `/tmp/agentpier-agency-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
  });
