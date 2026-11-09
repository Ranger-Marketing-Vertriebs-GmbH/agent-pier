// A session header action by its label: a header icon on wide screens, an entry of
// the More actions menu on a phone.
export async function sessionAction(page, name) {
  await page.locator(".session-heading").waitFor();
  const more = page
    .locator(".session-heading")
    .getByRole("button", { name: /^(More actions|Weitere Aktionen)$/ });
  if (await more.count()) {
    await more.click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    return;
  }
  await page.getByRole("button", { name, exact: true }).first().click();
}
