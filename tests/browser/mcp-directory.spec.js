import { test, expect } from "@playwright/test";
import { fits, openWizard, phone, primary, writes } from "./mcp-wizard-fixture.js";
import { directorySetup, dto } from "./mcp-directory-fixture.js";

async function search(page, term = "opnsense") {
  const wizard = await openWizard(page);
  await wizard.getByRole("radio", { name: /Search the directory/ }).check();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    wizard.getByText(/Your search is sent to registry\.modelcontextprotocol\.io/),
  ).toBeVisible();
  await expect(wizard.getByText(/Search matches server names only/)).toBeVisible();
  await wizard.getByLabel("Server name").fill(term);
  await wizard.getByRole("button", { name: "Search", exact: true }).click();
  return wizard;
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("results show what can run here; All shows the rest greyed", async ({
      page,
    }) => {
      await directorySetup(page);
      const wizard = await search(page);
      await expect(wizard.getByRole("status")).toHaveText("2 servers found");
      const card = wizard.getByRole("article", { name: "OPNsense" });
      await expect(card.getByText("io.github.example")).toBeVisible();
      await expect(card.getByText("npm package")).toBeVisible();
      await expect(card.getByText("oci – not supported")).toHaveClass(/is-unsupported/);
      await expect(wizard.getByRole("article", { name: /container-only/ })).toHaveCount(
        0,
      );
      await wizard.getByRole("button", { name: "All", exact: true }).click();
      await expect(
        wizard.getByRole("button", { name: "All", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const container = wizard.getByRole("article", { name: /container-only/ });
      await expect(container.getByText("Deprecated")).toBeVisible();
      await fits(page);
    });

    test("the detail explains verification and never installs by itself", async ({
      page,
    }) => {
      const state = await directorySetup(page);
      const wizard = await search(page);
      await wizard
        .getByRole("article", { name: "OPNsense" })
        .getByRole("button", { name: "OPNsense" })
        .click();
      const detail = page.getByRole("dialog", { name: "OPNsense" });
      await expect(detail.getByText(/Nobody reviewed the code/)).toBeVisible();
      await expect(
        detail.getByRole("link", {
          name: "Source: github.com/example/opnsense-mcp-server",
        }),
      ).toHaveAttribute("rel", "noopener noreferrer");
      await expect(
        detail.getByText("Link given by the publisher, not verified."),
      ).toBeVisible();
      const ways = detail.getByRole("group", { name: "How it runs" });
      await expect(ways.getByRole("radio", { name: /npm package/ })).toBeChecked();
      await expect(
        ways.getByRole("radio", { name: /oci – not supported/ }),
      ).toBeDisabled();
      await expect(
        ways.getByText("AgentPier installs npm and PyPI packages only."),
      ).toBeVisible();
      await expect(detail.getByText("OPNSENSE_API_KEY")).toBeVisible();
      await expect(
        detail.getByText(/A directory listing is not a security review/),
      ).toBeVisible();
      await detail.getByRole("button", { name: "Use this server" }).click();
      await expect(
        wizard.getByRole("heading", {
          level: 1,
          name: "Settings for opnsense-mcp-server",
        }),
      ).toBeVisible();
      expect(writes(state)).toEqual([]);
      const key = wizard.locator(".mcp-setting", { hasText: "OPNSENSE_API_KEY" });
      await expect(key.getByText("API key from OPNsense")).toBeVisible();
      await expect(key.getByText("Required")).toBeVisible();
    });

    test("an unreachable directory offers Try again; paging shows more", async ({
      page,
    }) => {
      const state = await directorySetup(page, {
        directory: { pages: { opnsense: [[dto.opnsense], [dto.files]] } },
      });
      state.directory.fail = {
        status: 503,
        json: {
          code: "MCP_DIRECTORY_UNAVAILABLE",
          error: "x",
          messageKey: "mcpDirectory.unavailable",
        },
      };
      const wizard = await search(page);
      await expect(wizard.getByRole("alert")).toContainText(
        "The directory is not reachable right now. Try again, or set the server up another way.",
      );
      state.directory.fail = null;
      await wizard.getByRole("button", { name: "Try again" }).click();
      await expect(wizard.getByRole("article", { name: "OPNsense" })).toBeVisible();
      await wizard.getByRole("button", { name: "Show more" }).click();
      await expect(
        wizard.getByRole("article", { name: /remote-filesystem/ }),
      ).toBeVisible();
    });

    test("no hit offers the other ways", async ({ page }) => {
      await directorySetup(page, { directory: { pages: { nothing: [[]] } } });
      const wizard = await search(page, "nothing");
      await expect(
        wizard.getByText("No server with this name in the directory."),
      ).toBeVisible();
      await wizard.getByRole("button", { name: "Set up a package" }).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Which package?" }),
      ).toBeVisible();
    });

    test("hits hidden by the filter offer All instead of no hit", async ({ page }) => {
      await directorySetup(page, {
        directory: { pages: { container: [[dto.container]] } },
      });
      const wizard = await search(page, "container");
      await expect(wizard.getByRole("status")).toHaveText(
        "1 server found, none can be installed here",
      );
      await expect(
        wizard.getByText("No server with this name in the directory."),
      ).toHaveCount(0);
      await wizard.getByRole("button", { name: "Show all", exact: true }).click();
      await expect(wizard.getByRole("article", { name: /container-only/ })).toBeVisible();
      await expect(wizard.getByRole("status")).toHaveText("1 server found");
    });

    test("opening a result says that its detail is loading", async ({ page }) => {
      await directorySetup(page);
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      await page.route(/\/api\/mcp-directory\/servers\/.+/, async (route) => {
        await gate;
        await route.fallback();
      });
      const wizard = await search(page);
      const card = wizard.getByRole("article", { name: "OPNsense" });
      await card.getByRole("button", { name: "OPNsense" }).click();
      await expect(wizard.getByRole("status")).toHaveText("Loading the server details …");
      await expect(card).toHaveAttribute("aria-busy", "true");
      release();
      await expect(page.getByRole("dialog", { name: "OPNsense" })).toBeVisible();
      await expect(card).not.toHaveAttribute("aria-busy", "true");
      await expect(wizard.getByRole("status")).toHaveText("2 servers found");
    });

    test("a directory turned off during the search links to Settings", async ({
      page,
    }) => {
      const state = await directorySetup(page);
      state.directory.fail = {
        status: 409,
        json: {
          code: "MCP_DIRECTORY_DISABLED",
          error: "x",
          messageKey: "mcpDirectory.disabled",
        },
      };
      const wizard = await search(page);
      const alert = wizard.getByRole("alert");
      await expect(alert).toContainText("Directory turned off");
      await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await alert.getByRole("link", { name: "Open settings" }).click();
      await expect(page).toHaveURL(/\/settings/);
    });

    test("an unreachable registry disables the directory card only", async ({ page }) => {
      await directorySetup(page, {
        directory: {
          status: {
            enabled: true,
            host: "registry.modelcontextprotocol.io",
            reachable: false,
          },
        },
      });
      const wizard = await openWizard(page);
      await expect(
        wizard.getByRole("radio", { name: /Search the directory/ }),
      ).toBeDisabled();
      await expect(wizard.getByText("Directory not reachable right now")).toBeVisible();
      await expect(
        wizard.getByRole("radio", { name: /Package from npm or PyPI/ }),
      ).toBeEnabled();
    });

    test("a turned-off or unreachable directory is named on the Source card", async ({
      page,
    }) => {
      await directorySetup(page, {
        directory: {
          status: {
            enabled: false,
            host: "registry.modelcontextprotocol.io",
            reachable: false,
          },
        },
      });
      const wizard = await openWizard(page);
      await expect(
        wizard.getByRole("radio", { name: /Search the directory/ }),
      ).toBeDisabled();
      await expect(wizard.getByText("Directory turned off")).toBeVisible();
      await expect(wizard.getByRole("link", { name: "Open settings" })).toBeVisible();
    });

    test("a remote entry composes its address from the variables and saves its origin", async ({
      page,
    }) => {
      const state = await directorySetup(page);
      const wizard = await search(page, "files");
      await wizard
        .getByRole("article", { name: /remote-filesystem/ })
        .getByRole("button")
        .first()
        .click();
      await page
        .getByRole("dialog", { name: /remote-filesystem/ })
        .getByRole("button", { name: "Use this server" })
        .click();
      await expect(page).toHaveURL(/step=remote/);
      await wizard.getByLabel("Value for {tenant}").fill("acme corp");
      await expect(
        wizard.getByText("Address: https://acme%20corp.files.example.test/mcp"),
      ).toBeVisible();
      await expect(
        wizard.getByText(/Listed in the directory as com\.pulsemcp\/remote-filesystem/),
      ).toBeVisible();
      await fits(page);
      await expect(wizard.getByLabel("Address", { exact: true })).toHaveAttribute(
        "readonly",
        "",
      );
      // The sign-in header from the directory is typed on this step.
      await wizard.getByLabel("Token", { exact: true }).fill("tok");
      await primary(wizard).click();
      await primary(wizard).click();
      await wizard.getByRole("button", { name: "Save server" }).click();
      await expect(page).toHaveURL(/step=connect/);
      const created = writes(state).find((r) => r.path === "/api/mcp-servers");
      expect(created.body).toMatchObject({
        url: "https://acme%20corp.files.example.test/mcp",
        headers: { Authorization: "Bearer tok" },
        origin: "directory",
        directoryOrigin: { name: "com.pulsemcp/remote-filesystem", version: "1.2.0" },
      });
    });

    test("the package step names the directory entry and can drop its hints", async ({
      page,
    }) => {
      await directorySetup(page);
      const wizard = await search(page);
      await wizard
        .getByRole("article", { name: "OPNsense" })
        .getByRole("button", { name: "OPNsense" })
        .click();
      await page
        .getByRole("dialog", { name: "OPNsense" })
        .getByRole("button", { name: "Use this server" })
        .click();
      await wizard.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/step=package/);
      await expect(
        wizard.getByText(
          "Listed in the directory as io.github.example/opnsense-mcp-server (0.4.1).",
        ),
      ).toBeVisible();
      const hints = wizard.getByRole("checkbox", { name: "Use its setup hints" });
      await expect(hints).toBeChecked();
      await hints.uncheck();
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        wizard
          .locator(".mcp-setting", { hasText: "OPNSENSE_API_KEY" })
          .getByText("No description"),
      ).toBeVisible();
    });
  });
}
