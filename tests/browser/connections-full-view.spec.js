import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { connectionsFixture, hostId } from "./connections-fixture.js";

// Zugänge entries (handoff 5.6, 5.10): the SSH full view with its form, "Benutzt von",
// last test, host key changed state and Verwalten; empty categories; phones.

const usedBy = (page) => page.getByRole("region", { name: /^Used by/ });

test("the full view shows the failed test with the server's message and tests again", async ({
  page,
}) => {
  const state = await connectionsFixture(page, { hosts: 6 });
  await page.goto(baseURL + `/connections?section=ssh&item=${hostId(3)}`);
  await expect(page.getByRole("heading", { level: 1, name: "server-003" })).toBeVisible();
  const box = page.getByRole("region", { name: "Last test" });
  await expect(box).toContainText("Test failed ·");
  await expect(box).toContainText("server-003:");
  await expect(box.locator(".connections-test-detail")).toHaveText(
    "deploy@10.0.0.3: Permission denied (publickey).",
  );
  await expect(box).toContainText("Is the public key on the host?");
  await box.getByRole("button", { name: "Test again" }).click();
  await expect(box).toContainText("Test succeeded ·");
  expect(
    state.sshCalls.filter((call) => call.path.endsWith(`${hostId(3)}/test`)),
  ).toHaveLength(1);
  // Verwalten: the activity log filtered to this access.
  await expect(page.getByRole("link", { name: /In the activity log/ })).toHaveAttribute(
    "href",
    `/settings/audit?resourceId=${hostId(3)}`,
  );
  await expect(page.getByText("1 agent and 1 hook lose access")).toHaveCount(0);
  // The back arrow leads to the list.
  await page.getByRole("button", { name: "Back to SSH/SFTP accesses" }).click();
  await expect(page).toHaveURL(/\/connections\?section=ssh$/);
});

test("a changed host key is shown with both fingerprints and accepted only on confirm", async ({
  page,
}) => {
  const state = await connectionsFixture(page, { hosts: 8 });
  await page.goto(baseURL + `/connections?section=ssh&item=${hostId(7)}`);
  const banner = page.getByRole("region", { name: "Host key changed" });
  await expect(banner).toContainText("SHA256:host-7");
  await banner.getByRole("button", { name: "Fetch current host key" }).click();
  await expect(banner).toContainText("SHA256:new-host");
  await banner.getByRole("button", { name: "Keep blocked" }).click();
  await expect(banner.getByRole("button", { name: "Accept new key" })).toHaveCount(0);
  await banner.getByRole("button", { name: "Fetch current host key" }).click();
  await banner.getByRole("button", { name: "Accept new key" }).click();
  await page
    .getByRole("dialog", { name: "Accept the new host key of server-007?" })
    .getByRole("button", { name: "Accept now" })
    .click();
  // The pinned key reads as untested until the next test.
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".connections-full-status")).toHaveText("Not tested yet.");
  expect(state.sshCalls.filter((call) => call.method === "PATCH")).toEqual([
    {
      path: `/api/ssh-accesses/${hostId(7)}`,
      method: "PATCH",
      body: { hostKey: "ssh-ed25519 new-host-key" },
    },
  ]);
});

test("the full view form keeps a draft with save bar and unsaved-changes guard", async ({
  page,
}) => {
  const state = await connectionsFixture(page, { hosts: 3 });
  await page.goto(baseURL + `/connections?section=ssh&item=${hostId(1)}`);
  await page.getByLabel("Name", { exact: true }).fill("renamed");
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toContainText("Changes apply to everyone who uses this access.");
  await page.getByRole("button", { name: "Back to SSH/SFTP accesses" }).click();
  const sheet = page.getByRole("dialog", { name: "Save changes?" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`item=${hostId(1)}`));
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar).toHaveCount(0);
  expect(state.sshCalls.find((call) => call.method === "PATCH").body.name).toBe(
    "renamed",
  );
  await expect(page.getByRole("heading", { level: 1, name: "renamed" })).toBeVisible();
});

test("Benutzt von adds an agent with a mode through the inline add field", async ({
  page,
}) => {
  const state = await connectionsFixture(page, { hosts: 3 });
  await page.goto(baseURL + `/connections?section=ssh&item=${hostId(2)}`);
  await expect(usedBy(page)).toContainText("Not in use yet.");
  const field = usedBy(page).getByRole("combobox", { name: "Add agent" });
  await field.click();
  await page.getByRole("option", { name: /Home/ }).click();
  await usedBy(page)
    .getByRole("combobox", { name: "Mode for new items" })
    .selectOption("routines");
  await usedBy(page).getByRole("button", { name: "Add 1" }).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0].access.sshAccesses).toEqual([
    { accessId: hostId(2), mode: "routines" },
  ]);
  await expect(usedBy(page).getByRole("combobox", { name: "Mode for Home" })).toHaveValue(
    "routines",
  );
  // Lowering the mode needs no confirmation; it writes the same policy.
  await usedBy(page)
    .getByRole("combobox", { name: "Mode for Home" })
    .selectOption("approval");
  await expect.poll(() => state.work.length).toBe(2);
  expect(state.work[1].access.sshAccesses).toEqual([
    { accessId: hostId(2), mode: "approval" },
  ]);
});

test("an empty SSH category offers adding an access and a key", async ({ page }) => {
  await connectionsFixture(page, { hosts: [] });
  await page.goto(baseURL + "/connections?section=ssh");
  await expect(
    page.getByRole("heading", { name: "No SSH or SFTP accesses yet" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add SSH key" }).first().click();
  await expect(page.getByRole("dialog", { name: "Add SSH key" })).toBeVisible();
});

test("on a phone, categories, list and entry are subpages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connectionsFixture(page, { hosts: 4 });
  await page.goto(baseURL + "/connections");
  await expect(
    page.getByRole("heading", { level: 1, name: "Connections" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Categories" })
    .getByRole("link", { name: /SSH\/SFTP accesses/ })
    .click();
  await expect(page).toHaveURL(/section=ssh$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "SSH/SFTP accesses" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Categories" })).toHaveCount(0);
  await page.getByRole("button", { name: "server-001", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`item=${hostId(1)}`));
  await expect(page.getByRole("heading", { level: 1, name: "server-001" })).toBeVisible();
  await page.getByRole("button", { name: "Back to SSH/SFTP accesses" }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Categories" })).toBeVisible();
});

test("category counts show a dash while unknown and a real zero as zero", async ({
  page,
}) => {
  await connectionsFixture(page, { hosts: 2 });
  await page.route("**/api/connections/problems", (route) =>
    route.fulfill({
      json: {
        agentsEnabled: true,
        models: null,
        services: null,
        mcp: null,
        ssh: { total: 2, problems: [], warnings: [], unknown: [] },
        secrets: null,
        github: { total: 0, problems: [], warnings: [], unknown: [] },
      },
    }),
  );
  await page.goto(baseURL + "/connections?section=ssh");
  const nav = page.getByRole("navigation", { name: "Categories" });
  await expect(nav.getByRole("link", { name: /^Secrets/ })).toContainText("—");
  await expect(nav.getByRole("link", { name: /^GitHub connections/ })).toContainText("0");
  await expect(nav.getByRole("link", { name: /^SSH\/SFTP accesses/ })).toContainText("2");
  await expect(nav.getByRole("link", { name: /^Services for agents/ })).toContainText(
    "3",
  );
});
