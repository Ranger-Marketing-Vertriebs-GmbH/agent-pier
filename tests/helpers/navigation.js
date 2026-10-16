// Navigation lives behind the „Menü“ popover in the sidebar (drawer on phones).
async function openDrawer(page) {
  // Login status is asynchronous; isVisible() alone does not wait for App to mount.
  await page.locator(".sidebar").waitFor({ state: "attached" });
  const drawer = page
    .getByRole("button", { name: /^(Navigation öffnen|Open navigation)$/ })
    .filter({ visible: true });
  if (
    (await drawer.count()) &&
    !(await page.locator(".sidebar").evaluate((node) => node.classList.contains("open")))
  )
    await drawer.first().click();
}
export async function openMenu(page) {
  await openDrawer(page);
  const trigger = page.locator(".sidebar .sidebar-menu-button");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const menu = page.locator("#sidebar-menu");
  await menu.waitFor({ state: "visible" });
  return menu;
}
export async function navigateTo(page, name) {
  const menu = await openMenu(page);
  await menu.getByRole("button", { name, exact: true }).click();
}
// "+ Neu" in the sidebar offers a session or an agent; on phones the header's "+"
// opens the session dialog directly.
export async function openNewSession(page) {
  await page.locator(".mobile-header").waitFor({ state: "attached" });
  const header = page
    .locator(".mobile-header")
    .getByRole("button", { name: /^(Neue Sitzung|New session)$/ });
  if (await header.isVisible()) return header.click();
  await page.locator(".sidebar").waitFor({ state: "attached" });
  await page
    .locator(".sidebar .sidebar-launch")
    .getByRole("button", { name: /^(Neu|New)$/ })
    .click();
  await page.getByRole("menuitem", { name: /^(Sitzung|Session)$/ }).click();
}
