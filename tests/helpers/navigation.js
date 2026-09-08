export async function navigateTo(page, name) {
  // Login status is asynchronous; isVisible() alone does not wait for App to mount.
  await page.locator(".sidebar").waitFor({ state: "attached" });
  const drawer = page.getByRole("button", { name: "Navigation öffnen", exact: true });
  if (
    (await drawer.isVisible()) &&
    !(await page.locator(".sidebar").evaluate((node) => node.classList.contains("open")))
  )
    await drawer.click();
  const group = page.getByRole("button", { name: "Verwaltung", exact: true });
  if (name !== "Übersicht" && (await group.getAttribute("aria-expanded")) === "false")
    await group.click();
  await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
}
