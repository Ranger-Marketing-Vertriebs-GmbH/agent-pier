import { expect } from "@playwright/test";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The hub entry (a link row) whose label starts with `name`. */
export const accountRow = (page, name) =>
  page
    .locator(".accounts-hub")
    .getByRole("link", { name: new RegExp(`^${escape(name)}`) });

/** The open detail subpage: the desktop pane or the phone subpage. */
export const accountDetail = (page) => page.locator(".accounts-detail");

/** The bottom save bar of the open detail. */
export const saveBar = (page) =>
  page.getByRole("region", { name: /^(Ungespeicherte Änderungen|Unsaved changes)$/ });

export async function openAccountItem(page, name) {
  await accountRow(page, name).first().click();
  await expect(accountDetail(page)).toBeVisible();
  return accountDetail(page);
}

/** Phones show the hub and a subpage one at a time; this returns to the hub. */
export async function backToAccounts(page) {
  const back = page.locator(".settings-shell-leading.back");
  if (await back.isVisible()) await back.click();
  await expect(page.locator(".accounts-hub")).toBeVisible();
}

/** A provider connection's key input; a saved key hides it behind "Replace". */
export async function keyInput(scope, label) {
  const replace = scope.getByRole("button", { name: /^(Ersetzen|Replace)$/ });
  if (await replace.count()) await replace.click();
  return scope.getByLabel(label, { exact: true });
}
