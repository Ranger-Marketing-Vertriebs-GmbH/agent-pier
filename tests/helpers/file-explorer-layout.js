export async function openExplorerPanel(page, panel) {
  const label = panel === "uploads" ? /^(Upload|Hochladen)$/ : /^(Activity|Aktivität)/;
  const toggle = page.getByRole("button", { name: label });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

export async function openExplorerDisclosure(page, selector) {
  const details = page.locator(selector);
  if (!(await details.evaluate((element) => element.open)))
    await details.locator("summary").click();
}

export async function openFileDetails(page) {
  await openExplorerDisclosure(page, ".file-details");
}
