import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";

async function populated(page) {
  const state = await fixture(page);
  state.accesses = Array.from({ length: 25 }, (_, index) => ({
    ...state.access,
    id: `host-${index}`,
    name: `Server ${String(index + 1).padStart(2, "0")}`,
    host: `host-${index + 1}.example.test`,
    username: index === 24 ? "operator" : "deploy",
    projectId: index < 20 ? "project-app" : "project-docs",
  }));
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  return state;
}

test("SSH list searches across pages and combines search with project ownership", async ({
  page,
}) => {
  const state = await populated(page);
  await page.goto(baseURL + "/settings/ssh");
  const rows = page.locator(".ssh-resource-row");
  await expect(rows).toHaveCount(20);
  await expect(
    page.getByRole("heading", { name: "SSH accesses", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /next page/i }).click();
  await expect(rows).toHaveCount(5);
  await page.getByRole("button", { name: "Server 25", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("host-25.example.test");
  const search = page.getByRole("searchbox");
  await search.fill("  HOST-1.EXAMPLE.TEST  ");
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("article")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Project filter" })
    .selectOption("project-docs");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("No matching entries.")).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(rows).toHaveCount(20);
  await search.fill("operator");
  await expect(rows).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Server 25", exact: true }),
  ).toBeVisible();
  expect(state.calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("details expose explicit connection actions and navigate to the shared key", async ({
  page,
}) => {
  const state = await populated(page);
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Server 01", exact: true }).click();
  await expect(page.getByText("SHA256:verified-host", { exact: true })).not.toBeVisible();
  await page.getByText("Host fingerprint", { exact: true }).click();
  await expect(page.getByText("SHA256:verified-host", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy public key", exact: true }).click();
  expect(await page.evaluate(() => window.copiedText)).toBe("ssh-ed25519 public-fixture");
  expect(state.calls.filter((call) => call.path.endsWith("/test"))).toEqual([]);
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Connection successful", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View key", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Keys/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("article")).toContainText("Deployment key");
  await expect(
    page.getByRole("article").getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: ".cache/ssh-redesign-keys-en.png", fullPage: true });
});

test("mobile details return keyboard focus to the selected row without horizontal overflow", async ({
  page,
}) => {
  await populated(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/settings/ssh");
  const row = page.getByRole("button", { name: "Server 01", exact: true });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({ path: ".cache/ssh-redesign-mobile-en.png", fullPage: true });
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("same-name rows describe their endpoint, owner and key to assistive technology", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [
    {
      ...state.access,
      id: "app",
      name: "Deployment",
      host: "app.example.test",
      projectId: "project-app",
    },
    {
      ...state.access,
      id: "docs",
      name: "Deployment",
      host: "docs.example.test",
      projectId: "project-docs",
    },
  ];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  const rows = page.getByRole("button", { name: "Deployment", exact: true });
  await expect(rows.nth(0)).toHaveAccessibleDescription(
    /deploy@app.example.test.*Agent app.*Deployment key/,
  );
  await expect(rows.nth(1)).toHaveAccessibleDescription(
    /deploy@docs.example.test.*Docs.*Deployment key/,
  );
});

test("pending or failed access catalogs never present keys as unused or deletable", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route("**/api/ssh-accesses", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await pending;
      return route.fulfill({ status: 503, json: { error: "Access catalog offline" } });
    }
    return route.fulfill({ json: { accesses: state.accesses } });
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("tab", { name: /Keys/ }).click();
  try {
    const row = page.getByRole("button", { name: "Deployment key", exact: true });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("0 accesses");
    await row.click();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(
      0,
    );
  } finally {
    release();
  }
  await expect(page.getByRole("alert")).toContainText("Access catalog offline");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Deployment key", exact: true }),
  ).toContainText("1 access");
  await page.getByRole("button", { name: "Deployment key", exact: true }).click();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
});

test("deleting the last entry on a page returns to the remaining entries", async ({
  page,
}) => {
  const state = await populated(page);
  state.accesses = state.accesses.slice(0, 21);
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: /next page/i }).click();
  await page.getByRole("button", { name: "Server 21", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.locator(".ssh-resource-row")).toHaveCount(20);
  await expect(
    page.getByRole("button", { name: "Server 01", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toBeFocused();
});

test("German desktop and mobile views keep long project names readable and tabs keyboard accessible", async ({
  page,
}) => {
  const state = await fixture(page);
  const examples = [
    ["Production", "deploy", "prod", "Webshop"],
    ["Staging", "deploy", "staging", "Webshop"],
    ["Build Runner", "ci", "build", "AgentPier"],
    ["Dokumentation", "deploy", "docs", "Website"],
    ["Datenbank", "admin", "db", "Webshop"],
    ["Monitoring", "ops", "metrics", "Infrastruktur"],
    ["Backup", "backup", "backup", "Infrastruktur"],
    ["Testserver", "dev", "test", "Global"],
    ["Preview", "deploy", "preview", "Website"],
  ];
  state.projects = ["Webshop", "AgentPier", "Website", "Infrastruktur"].map((name) => ({
    id: name,
    name,
    cwd: `/work/${name}`,
    kind: "git",
  }));
  const template = state.keys[0];
  state.keys = examples.map(([, username, host, project], index) => ({
    ...template,
    id: `key-${index}`,
    name: `${username}-${host}`,
    projectId: project === "Global" ? null : project,
  }));
  state.accesses = examples.map(([name, username, host, project], index) => ({
    ...state.access,
    id: `host-${index}`,
    name,
    username,
    host: `${host}.example`,
    keyId: `key-${index}`,
    projectId: project === "Global" ? null : project,
  }));
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "SSH-Zugänge", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(page.getByRole("article")).toBeVisible();
  await page.screenshot({ path: ".cache/ssh-redesign-desktop-de.png", fullPage: true });
  const accesses = page.getByRole("tab", { name: /^Zugänge/ });
  await accesses.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /^Schlüssel/ })).toBeFocused();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.getByRole("searchbox").fill("deploy-prod");
  await expect(page.locator(".ssh-resource-row")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await accesses.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".cache/ssh-redesign-list-mobile-de.png",
    fullPage: true,
    animations: "disabled",
  });
  state.projects[0].name = "Webshop".repeat(35);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Production", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
