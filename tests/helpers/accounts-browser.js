import { expect } from "@playwright/test";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (name) => new RegExp(`^${escape(name)}`);

/** The hub entry (a link row) whose label starts with `name`. */
export const accountRow = (page, name) =>
  page.locator(".accounts-hub").getByRole("link", { name: startsWith(name) });

/** The open detail subpage: the desktop pane or the phone subpage. */
export const accountDetail = (page) => page.locator(".accounts-detail");

/** The bottom save bar of the open detail. */
export const saveBar = (page) =>
  page.getByRole("region", { name: /^(Ungespeicherte Änderungen|Unsaved changes)$/ });

const shown = (locator, timeout = 1500) =>
  locator.waitFor({ state: "visible", timeout }).then(
    () => true,
    () => false,
  );

/**
 * Opens an entry of Zugänge (model access, services, MCP servers) or of Coding ›
 * Accounts: a list row, an MCP server of the long list (through its full view) or
 * the MCP list's "In den CLIs gefunden". An entry of another Zugänge category is
 * looked up category by category.
 */
async function openEntry(page, name) {
  const hub = accountRow(page, name).first();
  const server = page
    .locator(".long-list")
    .getByRole("button", { name: startsWith(name) })
    .first();
  const finds = page
    .locator(".connections-category-head, .connections-empty")
    .getByRole("button", { name: startsWith(name) })
    .first();
  // Whichever shows first: the page may still be loading its lists.
  if (!(await shown(hub.or(finds).or(server).first(), 2500))) return null;
  if (await hub.isVisible()) return hub.click();
  if (await finds.isVisible()) return finds.click();
  await server.click();
  const full = page.getByRole("link", { name: /^(Vollansicht|Full view)$/ });
  // Phones open the server's page right away.
  if (await shown(full, 1000)) await full.click();
  return undefined;
}

export async function openAccountItem(page, name) {
  if ((await openEntry(page, name)) === null) {
    const nav = page.getByRole("navigation", { name: /^(Kategorien|Categories)$/ });
    // From an entry or a list, phones go up to the categories.
    const back = page.locator(".settings-shell-leading.back");
    for (let step = 0; step < 2 && !(await shown(nav, 500)); step += 1)
      if (await back.isVisible()) await back.click();
    const links = nav.getByRole("link");
    let opened = false;
    for (let index = 0; index < (await links.count()) && !opened; index += 1) {
      await links.nth(index).click();
      opened = (await openEntry(page, name)) !== null;
      if (!opened && !(await shown(nav, 200)) && (await back.isVisible()))
        await back.click();
    }
    if (!opened) throw new Error(`No Zugänge entry named ${name}`);
  }
  await expect(accountDetail(page)).toBeVisible();
  return accountDetail(page);
}

/** Phones show a list and an entry one at a time; this returns from the entry to its list. */
export async function backToAccounts(page) {
  const back = page.locator(".settings-shell-leading.back");
  if ((await accountDetail(page).isVisible()) && (await back.isVisible()))
    await back.click();
  await expect(
    page
      .locator(".accounts-hub, .long-list, .connections-empty")
      .or(page.getByRole("navigation", { name: /^(Kategorien|Categories)$/ }))
      .first(),
  ).toBeVisible();
}

/** A provider connection's key input; a saved key hides it behind "Replace". */
export async function keyInput(scope, label) {
  const replace = scope.getByRole("button", { name: /^(Ersetzen|Replace)$/ });
  if (await replace.count()) await replace.click();
  return scope.getByLabel(label, { exact: true });
}
