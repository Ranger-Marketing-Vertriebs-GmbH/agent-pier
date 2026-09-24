const groupOf = {
  Projekte: "projects",
  Projects: "projects",
  Dateien: "projects",
  Files: "projects",
  Pipelines: "projects",
  Accounts: "configuration",
  Erweiterungen: "configuration",
  Extensions: "configuration",
  Einstellungen: "configuration",
  Settings: "configuration",
};
export async function navigateTo(page, name) {
  // Login status is asynchronous; isVisible() alone does not wait for App to mount.
  await page.locator(".sidebar").waitFor({ state: "attached" });
  const drawer = page.getByRole("button", { name: "Navigation öffnen", exact: true });
  if (
    (await drawer.isVisible()) &&
    !(await page.locator(".sidebar").evaluate((node) => node.classList.contains("open")))
  )
    await drawer.click();
  const groupName = groupOf[name];
  if (!groupName) {
    await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
    return;
  }
  const toggle = page.locator(`.${groupName}-group > .sidebar-group-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page
    .locator(`.${groupName}-group .nav-item`)
    .filter({ hasText: name })
    .first()
    .click();
}
