import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { expectTouchSized, phone } from "./touch-input-size.js";

// Every main view on the isolated server; the forms spec covers dialogs with data.
test.use(phone);

const pages = [
  ["workspace", "/"],
  ["agents", "/agents"],
  ["new agent", "/agents?new=1"],
  ["accounts", "/accounts"],
  ["accounts models", "/accounts?section=models"],
  ["accounts services", "/accounts?section=services"],
  ["accounts mcp", "/accounts?section=mcp-servers"],
  ["accounts cli", "/accounts?section=cli"],
  ["new connection", "/accounts?section=models&item=new"],
  ["mcp wizard", "/accounts?section=mcp-servers&item=new&step=source"],
  ["mcp wizard remote", "/accounts?section=mcp-servers&item=new&step=remote"],
  ["mcp wizard command", "/accounts?section=mcp-servers&item=new&step=command"],
  ["mcp wizard package", "/accounts?section=mcp-servers&item=new&step=package"],
  ["projects", "/repositories"],
  ["files", "/files"],
  ["artifacts", "/artifacts"],
  ["memory", "/memory"],
  ["agentbus", "/agentbus"],
  ["extensions", "/extensions"],
  ["plugins", "/plugins"],
  ["pipelines runs", "/pipelines"],
  ["pipelines definitions", "/pipelines/definitions"],
  ["pipelines profiles", "/pipelines/profiles"],
  ["pipelines verification", "/pipelines/verification"],
  ["settings", "/settings"],
  ["settings access", "/settings?tab=access"],
  ["settings operations", "/settings?tab=operations"],
  ["settings agents", "/settings/assistants"],
  ["settings agents advanced", "/settings/assistants-advanced"],
  ["settings notifications", "/settings/notifications"],
  ["settings diagnostics", "/settings/diagnostics"],
  ["settings backups", "/settings/backups"],
  ["settings updates", "/settings/updates"],
  ["settings audit", "/settings/audit"],
  ["settings mcp", "/settings/mcp"],
  ["settings remote", "/settings/remote"],
  ["settings ssh", "/settings/ssh"],
  ["settings github", "/settings/github"],
];

for (const [view, path] of pages)
  test(`${view} keeps text entry at 16px on a phone`, async ({ page }) => {
    await page.goto(baseURL + path);
    await page.locator("#root *").first().waitFor();
    await page.waitForTimeout(1500);
    await expectTouchSized(page, view);
  });

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false });

  test("text entry keeps its compact desktop size", async ({ page }) => {
    await page.goto(baseURL + "/artifacts");
    const search = page.locator(".artifacts-search input");
    await expect(search).toBeVisible();
    await expect(search).toHaveCSS("font-size", "14px");
  });
});
