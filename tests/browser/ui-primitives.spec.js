import { test, expect } from "@playwright/test";

// ConfirmDialog, Switch, Checkbox and CopyButton through the component gallery
// (docs/ui-guide.md#components): one order, danger only for destructive actions,
// Cancel first on a destructive confirmation, and the action on top on phones.
test.use({ locale: "en-GB" });

const open = async (page, name) => {
  await page.goto("/settings/components");
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
};

test("a destructive confirmation names the object, uses danger and starts on Cancel", async ({
  page,
}) => {
  await open(page, "Confirm a deletion");
  const dialog = page.getByRole("dialog", { name: "Delete the backup “nightly”?" });
  await expect(dialog).toContainText("This cannot be undone.");
  const confirm = dialog.getByRole("button", { name: "Delete now", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(confirm).toHaveClass(/\bdanger\b/);
  await expect(cancel).toBeFocused();
  const [cancelBox, confirmBox] = [
    await cancel.boundingBox(),
    await confirm.boundingBox(),
  ];
  expect(cancelBox.x).toBeLessThan(confirmBox.x);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a non-destructive confirmation uses a primary button", async ({ page }) => {
  await open(page, "Confirm a change");
  const dialog = page.getByRole("dialog", { name: "Activate version 2.3.0?" });
  const confirm = dialog.getByRole("button", { name: "Activate now", exact: true });
  await expect(confirm).toHaveClass(/\bprimary\b/);
  await expect(confirm).not.toHaveClass(/\bdanger\b/);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the confirming action sits above Cancel and both are touch sized", async ({
    page,
  }) => {
    await open(page, "Confirm a deletion");
    const dialog = page.getByRole("dialog", { name: "Delete the backup “nightly”?" });
    const confirm = await dialog
      .getByRole("button", { name: "Delete now", exact: true })
      .boundingBox();
    const cancel = await dialog
      .getByRole("button", { name: "Cancel", exact: true })
      .boundingBox();
    expect(confirm.y).toBeLessThan(cancel.y);
    expect(confirm.height).toBeGreaterThanOrEqual(44);
    expect(cancel.height).toBeGreaterThanOrEqual(44);
  });
});

test("Switch and Checkbox are labelled controls with the shared look", async ({
  page,
}) => {
  await page.goto("/settings/components");
  const toggle = page.getByRole("switch", { name: "Notify me", exact: true });
  await expect(toggle).toBeChecked();
  await page.getByText("Notify me", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveCSS("width", "38px");
  const box = page.getByRole("checkbox", { name: "Include history", exact: true });
  await expect(box).not.toBeChecked();
  await page.getByText("Include history", { exact: true }).click();
  await expect(box).toBeChecked();
  await expect(box).toHaveCSS("background-color", "rgb(244, 154, 88)");
});

test("CopyButton writes the text and announces the result", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Clipboard permissions are Chromium only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings/components");
  const specimen = page.locator(".gallery-specimen").filter({ hasText: "CopyButton" });
  await specimen
    .getByRole("button", { name: "Copy command: Sample", exact: true })
    .first()
    .click();
  await expect(specimen.getByRole("status").first()).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npm run check");
});
