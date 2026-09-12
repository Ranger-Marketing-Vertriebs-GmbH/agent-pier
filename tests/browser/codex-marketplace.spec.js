import { test, expect } from "@playwright/test";
import { navigateTo } from "../helpers/navigation.js";
import { baseURL } from "../helpers/browser.js";

const builtin = {
  name: "openai-curated-remote",
  source: "Codex default marketplace",
  builtin: true,
  removable: false,
  updatable: false,
};
const accounts = [
  { id: "local-codex", name: "Lokales Codex", kind: "local", tool: "codex" },
  { id: "work-codex", name: "Codex Arbeit", kind: "managed", tool: "codex" },
  { id: "personal-codex", name: "Codex Privat", kind: "managed", tool: "codex" },
];
function inventory(id, installed = false) {
  const remote = id !== "local-codex";
  return {
    tool: "codex",
    available: true,
    busy: false,
    note: "Lokale Erweiterungen werden für Codex gemeinsam verwaltet.",
    catalogAccounts: accounts.map(({ id, name }) => ({ id, name })),
    catalogAccountId: id,
    catalogReason: remote
      ? null
      : "Der Standard-Marketplace benötigt ein angemeldetes Codex-Konto.",
    capabilities: { marketplaces: true, install: true },
    marketplaces: [builtin, { name: "local-market", source: "/fixture/plugins" }],
    installed: installed
      ? [{ id: "demo@openai-curated-remote", name: "Remote Demo", removable: true }]
      : [],
    catalog: remote
      ? [
          {
            id: "demo@openai-curated-remote",
            name: "Remote Demo",
            description: `Katalog für ${id === "work-codex" ? "Arbeit" : "Privat"}`,
            marketplace: builtin.name,
            installed,
          },
        ]
      : [],
  };
}
async function setup(page) {
  const writes = [],
    reads = [];
  const installed = new Set();
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          accounts,
          sharedCliExtensions: true,
          tools: [{ id: "codex", name: "Codex", installed: true }],
          sessions: [],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/plugins")) {
      const id = url.searchParams.get("catalogAccountId") || "local-codex";
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        writes.push(body);
        if (body.action === "install")
          installed.add(body.catalogAccountId || "local-codex");
        return route.fulfill({ json: { ok: true } });
      }
      reads.push(id);
      return route.fulfill({ json: inventory(id, installed.has(id)) });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL);
  await navigateTo(page, "Plugins & Marketplace");
  return { writes, reads };
}

test("Codex native marketplace uses an explicit catalog account and has no source mutations", async ({
  page,
}, testInfo) => {
  const { writes, reads } = await setup(page);
  const selector = page.getByLabel("Marketplace-Konto", { exact: true });
  await expect(selector).toHaveValue("local-codex");
  await expect(
    page.getByText(
      "Wähle ein bei Codex angemeldetes Konto. Plugins aus dem Standard-Marketplace werden für dieses Konto installiert.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Der Standard-Marketplace benötigt ein angemeldetes Codex-Konto."),
  ).toBeVisible();
  expect(reads).toEqual(["local-codex"]);
  const market = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Codex-Standard-Marketplace", exact: true }),
  });
  await expect(market).toBeVisible();
  await expect(market.getByRole("button")).toHaveCount(0);
  await page.getByLabel("Marketplace filtern").selectOption("openai-curated-remote");
  await expect(
    page
      .getByLabel("Marketplace filtern")
      .getByRole("option", { name: "Codex-Standard-Marketplace" }),
  ).toHaveCount(1);
  await selector.selectOption("work-codex");
  await expect(page.getByText("Katalog für Arbeit")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("codex-default-marketplace.png"),
    fullPage: true,
    animations: "disabled",
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/accounts/local-codex/plugins", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    return route.fallback();
  });
  await page.getByRole("button", { name: "Plugin Remote Demo installieren" }).click();
  await expect(selector).toBeDisabled();
  await expect(page.getByLabel("CLI", { exact: true })).toBeDisabled();
  release();
  await expect(selector).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Plugin Remote Demo installieren" }),
  ).toBeDisabled();
  expect(writes).toEqual([
    {
      action: "install",
      pluginId: "demo@openai-curated-remote",
      catalogAccountId: "work-codex",
    },
  ]);
  await selector.selectOption("personal-codex");
  await expect(page.getByText("Katalog für Privat")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Plugin Remote Demo installieren" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Plugin Remote Demo entfernen" }),
  ).toHaveCount(0);
});

for (const failure of [false, true]) {
  test(`late ${failure ? "failed" : "successful"} catalog read cannot replace another account`, async ({
    page,
  }) => {
    await setup(page);
    const selector = page.getByLabel("Marketplace-Konto", { exact: true });
    await expect(selector).toHaveValue("local-codex");
    let release, started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const requested = new Promise((resolve) => {
      started = resolve;
    });
    await page.route(
      "**/accounts/local-codex/plugins?catalogAccountId=work-codex",
      async (route) => {
        started();
        await held;
        return route.fulfill(
          failure
            ? { status: 503, json: { error: "Veralteter Kontofehler" } }
            : { json: inventory("work-codex", true) },
        );
      },
    );
    await selector.selectOption("work-codex");
    await requested;
    await expect(
      page.getByRole("button", { name: "Plugin Remote Demo installieren" }),
    ).toHaveCount(0);
    await selector.selectOption("personal-codex");
    await expect(page.getByText("Katalog für Privat")).toBeVisible();
    const finished = page.waitForResponse((response) =>
      response.url().includes("catalogAccountId=work-codex"),
    );
    release();
    await (await finished).finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(selector).toHaveValue("personal-codex");
    await expect(page.getByText("Katalog für Privat")).toBeVisible();
    await expect(page.getByText("Katalog für Arbeit")).toHaveCount(0);
    await expect(page.getByText("Veralteter Kontofehler")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Plugin Remote Demo installieren" }),
    ).toBeEnabled();
  });
}
