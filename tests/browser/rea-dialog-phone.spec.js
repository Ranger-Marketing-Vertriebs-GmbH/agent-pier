import { test, expect } from "@playwright/test";
import { fixture, openDialog, reaState } from "./rea-fixture.js";

// The REA dialog on a phone while a change runs: the bottom sheet's footer keeps both
// buttons whole, side by side, with nothing drawn between them.
test("the running REA dialog's footer buttons stay whole on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const running = reaState({
    status: "running",
    message: "Loading Ghidra for REA … 93 %",
  });
  await fixture(page, reaState(), { apply: { status: 202, json: running } });
  const dialog = await openDialog(page);
  await dialog.getByRole("checkbox", { name: /I understand/ }).check();
  // From the click on, the server reports the running change.
  await page.route("**/api/rea", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: running })
      : route.fallback(),
  );
  const footer = dialog.locator(".dialog-actions");
  const install = footer.getByRole("button", { name: "Install", exact: true });
  const boxesBefore = await footer
    .locator(".button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().toJSON()),
    );
  await install.click();
  await expect(dialog.getByRole("status")).toContainText("93 %");
  const close = footer.getByRole("button", { name: "Close", exact: true });
  const busy = footer.getByRole("button", { name: "Working …" });
  await expect(busy).toBeDisabled();
  await footer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".cache/rea-dialog-phone-en.png" });
  const layout = await footer.evaluate((element) => {
    const box = (node) => node.getBoundingClientRect().toJSON();
    const buttons = [...element.querySelectorAll(":scope > *")]
      .filter((node) => node.getClientRects().length)
      .map((node) => ({ text: node.textContent.trim(), ...box(node) }));
    const [left, right] = buttons;
    const y = (left.top + left.bottom) / 2;
    // Every point of the gap between the buttons shows the footer itself.
    const gap = [];
    for (let x = Math.ceil(left.right) + 1; x < Math.floor(right.left); x++)
      gap.push(document.elementFromPoint(x, y) === element);
    return { footer: box(element), buttons, gap, width: innerWidth };
  });
  expect(layout.buttons.map((button) => button.text)).toEqual(["Close", "Working …"]);
  const [left, right] = layout.buttons;
  for (const button of layout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(layout.footer.left);
    expect(button.right).toBeLessThanOrEqual(layout.footer.right);
    expect(button.right).toBeLessThanOrEqual(layout.width);
  }
  expect(left.right).toBeLessThanOrEqual(right.left);
  expect(layout.gap.every(Boolean)).toBe(true);
  // The busy label never resizes the buttons: iOS Safari left stale paint of the old
  // layout (a sliver of the orange Install fill over a clipped Close) when it did.
  expect(layout.buttons.map(({ left, right }) => ({ left, right }))).toEqual(
    boxesBefore.map(({ left, right }) => ({ left, right })),
  );
  await expect(close).toBeVisible();
  await close.click();
  await expect(dialog).toBeHidden();
});
