export const detail = (page, name) =>
  page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });

export async function showAccesses(page) {
  await page.getByRole("tab", { name: /^(Zugänge|Accesses)\s/ }).click();
}
export async function showKeys(page) {
  await page.getByRole("tab", { name: /^(Schlüssel|Keys)\s/ }).click();
}
export async function openAccess(page, name) {
  await showAccesses(page);
  await page.getByRole("button", { name, exact: true }).click();
}
export async function openKey(page, name) {
  await showKeys(page);
  await page.getByRole("button", { name, exact: true }).click();
}
