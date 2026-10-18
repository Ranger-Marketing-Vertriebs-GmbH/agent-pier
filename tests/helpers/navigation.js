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
// "+ Neu" offers a session or an agent: in the sidebar, in the phone header and in the
// floating bar of a collapsed sidebar. This picks whichever one is on screen.
export async function openNewSession(page) {
  await page.locator(".mobile-header").waitFor({ state: "attached" });
  const name = /^(Neu|New)$/;
  const header = page.locator(".mobile-header").getByRole("button", { name });
  const float = page.locator(".sidebar-float").getByRole("button", { name });
  if (await header.isVisible()) await header.click();
  else if (await float.isVisible()) await float.click();
  else {
    await page.locator(".sidebar").waitFor({ state: "attached" });
    await page.locator(".sidebar .sidebar-launch").getByRole("button", { name }).click();
  }
  await page.getByRole("menuitem", { name: /^Session$/ }).click();
}
