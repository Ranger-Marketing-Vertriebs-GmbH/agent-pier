import { test, expect } from "@playwright/test";

// AddPicker (docs/ui-guide.md#rows-and-controls, handoff 5.5, AC-AS-3 component part) in
// Settings › Operations › Development › Components, operated by keyboard only: type to
// filter, arrows, Space toggles, Enter adds, Escape closes and keeps the field focused.
test.use({ locale: "en-GB" });

async function openGallery(page) {
  await page.goto("/settings/components");
  const card = page.getByRole("group", { name: "SSH accesses of the sample agent" });
  const field = card.getByRole("combobox", { name: "Add SSH access" });
  await expect(field).toHaveAttribute("placeholder", "Add SSH access …");
  return { card, field };
}

test("the picker filters, multi-selects and adds by keyboard only", async ({ page }) => {
  const { card, field } = await openGallery(page);
  await field.focus();
  await expect(field).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.type("prod-web-0");
  await expect(field).toHaveAttribute("aria-expanded", "true");
  const list = card.getByRole("listbox", { name: "SSH access: options" });
  await expect(list).toHaveAttribute("aria-multiselectable", "true");
  await expect(card.getByRole("status")).toHaveText("9 matches");
  await expect(list.getByRole("option")).toHaveCount(9);

  const granted = list.getByRole("option", { name: /prod-web-01/ });
  await expect(granted).toHaveAttribute("aria-disabled", "true");
  await expect(granted).toContainText("already granted");

  // The first arrow opens, the next ones move and skip the granted row.
  await page.keyboard.press("ArrowDown");
  const second = list.getByRole("option", { name: /prod-web-02/ });
  await expect(field).toHaveAttribute(
    "aria-activedescendant",
    await second.getAttribute("id"),
  );
  await page.keyboard.press("Space");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(list.getByRole("option", { name: /prod-web-03/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Space toggles back and forth.
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect(field).toHaveValue("prod-web-0");
  await expect(card.getByRole("button", { name: "Add 2" })).toBeEnabled();

  // The mode applies to all new items.
  await page.keyboard.press("Tab");
  const mode = card.getByRole("combobox", { name: "Mode for new items" });
  await expect(mode).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(mode).toHaveValue("trusted");
  await page.keyboard.press("Escape");
  await expect(field).toBeFocused();
  await expect(list).toBeHidden();

  // Reopening keeps the checked items; Enter adds them into the card.
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("button", { name: "Add 2" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  for (const name of ["prod-web-02", "prod-web-03"])
    await expect(card.getByText(name, { exact: true })).toBeVisible();
  await expect(card.getByText("Trusted", { exact: true })).toHaveCount(2);

  // Added items now show as already granted.
  await page.keyboard.type("prod-web-02");
  await expect(list.getByRole("option", { name: /prod-web-02/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
});

test("Enter adds the active row alone and long lists stay capped", async ({ page }) => {
  const { card, field } = await openGallery(page);
  await field.focus();
  await page.keyboard.press("ArrowDown");
  const list = card.getByRole("listbox", { name: "SSH access: options" });
  await expect(card.getByRole("status")).toHaveText("600 matches");
  await expect(list.getByRole("option")).toHaveCount(50);
  await expect(card.getByText("550 more – refine the search")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect(field).toHaveAttribute(
    "aria-activedescendant",
    await list.getByRole("option", { name: /prod-web-02/ }).getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(card.getByText("prod-web-02", { exact: true })).toBeVisible();
  await expect(card.getByText("With approval", { exact: true })).toHaveCount(2);
});

test("the server search variant debounces and shows its results", async ({ page }) => {
  await page.goto("/settings/components");
  const card = page.getByRole("group", { name: "MCP servers of the sample agent" });
  const field = card.getByRole("combobox", { name: "Add MCP server" });
  await field.focus();
  await page.keyboard.type("post");
  const list = card.getByRole("listbox", { name: "MCP server: options" });
  await expect(card.getByRole("status")).toHaveText("1 match");
  await expect(list.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(card.getByText("postgres", { exact: true })).toBeVisible();
  await expect(field).toBeFocused();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("rows are touch sized and the panel fits the screen", async ({ page }) => {
    const { card, field } = await openGallery(page);
    await field.tap();
    const list = card.getByRole("listbox", { name: "SSH access: options" });
    await expect(list).toBeVisible();
    const option = list.getByRole("option").nth(1);
    const box = await option.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    await option.tap();
    await expect(option).toHaveAttribute("aria-selected", "true");
    const add = card.getByRole("button", { name: "Add 1" });
    const addBox = await add.boundingBox();
    expect(addBox.x + addBox.width).toBeLessThanOrEqual(391);
    expect(
      await page.evaluate(
        () =>
          document.scrollingElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
  });
});
