import { test, expect } from "../helpers/browser-test.js";

// DiffReview through its component gallery specimens (docs/ui-guide.md, "Code and
// diffs"): fixture data in web/features/gallery/gallery-fixtures.js, nothing is sent.
test.use({ locale: "en-GB" });

const editable = (page) => page.locator("[data-specimen=diff-review]");
const readOnly = (page) => page.locator("[data-specimen=diff-read-only]");

async function open(page) {
  await page.goto("/settings/components");
  await expect(editable(page)).toBeVisible();
}

// The fixture's `timingSafeEqual` row is the fourth selectable row of server/a.js.
async function selectLine(page, presses = 4) {
  const region = editable(page).getByRole("region", { name: "Diff of server/a.js" });
  await region.focus();
  for (let i = 0; i < presses; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  return region;
}

test("the keyboard flow comments, resolves, reopens and deletes", async ({ page }) => {
  await open(page);
  const region = await selectLine(page, 4);
  await editable(page).getByRole("button", { name: "Comment on line 12" }).click();
  const box = editable(page).getByLabel("Comment (Markdown)");
  await expect(editable(page).getByRole("button", { name: "Save" })).toBeDisabled();
  await box.fill("A new note on this line");
  await page.keyboard.press("Control+Enter");
  const note = editable(page).locator(".diff-thread", { hasText: "A new note" });
  await expect(note).toBeVisible();
  await expect(region).toBeFocused();

  await note.getByRole("button", { name: "Resolve" }).click();
  const resolved = editable(page).locator(".diff-thread.is-resolved", {
    hasText: "A new note",
  });
  await expect(resolved.getByRole("button", { name: "Reopen" })).toBeFocused();
  await resolved.getByRole("button", { name: "Reopen" }).click();
  await expect(note.getByRole("button", { name: "Resolve" })).toBeVisible();
  await expect(note.getByRole("button", { name: "Resolve" })).toBeFocused();

  await note.getByRole("button", { name: "Delete" }).click();
  await expect(note.getByText("Delete this comment?")).toBeVisible();
  await note.getByRole("button", { name: "Cancel" }).click();
  await expect(note).toBeVisible();
  await expect(note.getByRole("button", { name: "Delete" })).toBeFocused();
  await note.getByRole("button", { name: "Delete" }).click();
  await note.getByRole("button", { name: "Delete now" }).click();
  await expect(editable(page).getByText("A new note")).toHaveCount(0);
  await expect(region).toBeFocused();
});

test("Escape closes the editor without saving", async ({ page }) => {
  await open(page);
  await selectLine(page, 4);
  await editable(page).getByRole("button", { name: "Comment on line 12" }).click();
  await editable(page).getByLabel("Comment (Markdown)").fill("Never saved");
  await page.keyboard.press("Escape");
  await expect(editable(page).getByLabel("Comment (Markdown)")).toHaveCount(0);
  await expect(editable(page).getByText("Never saved")).toHaveCount(0);
});

test("a comment can be edited", async ({ page }) => {
  await open(page);
  const thread = editable(page).locator(".diff-thread", { hasText: "constant-time" });
  await expect(thread.locator("strong")).toHaveText("constant-time");
  await thread.getByRole("button", { name: "Edit" }).click();
  const box = editable(page).getByLabel("Comment (Markdown)");
  await expect(box).toHaveValue("Use a **constant-time** comparison here.");
  await box.fill("Edited text");
  await page.keyboard.press("Control+Enter");
  await expect(editable(page).getByText("Edited text")).toBeVisible();
  await expect(
    editable(page)
      .locator(".diff-thread", { hasText: "Edited text" })
      .getByRole("button", { name: "Edit" }),
  ).toBeFocused();
});

test("outdated, sent, paged and missing-file comments are listed", async ({ page }) => {
  await open(page);
  const outdated = editable(page).locator(".diff-thread", {
    hasText: "Drop this log line",
  });
  await expect(outdated.getByText("Outdated")).toBeVisible();
  await expect(outdated.getByText("console.log(token);")).toBeVisible();
  await expect(editable(page).getByText("Sent in batch 1")).toBeVisible();

  // The comment on a row past the first 400 is listed with a hint, then moves in place.
  const big = editable(page).locator(".diff-file", { hasText: "server/big.js" });
  const listed = big.locator(".diff-file-comments li", { hasText: "Please add a test" });
  await expect(listed.getByText(/Show more lines to see it in place/)).toBeVisible();
  await big.getByRole("button", { name: /Show \d+ more/ }).click();
  await expect(big.locator(".diff-file-comments")).toHaveCount(0);
  await expect(big.getByText("Please add a test")).toBeVisible();

  await expect(
    editable(page).getByText("Comments on files that are no longer changed"),
  ).toBeVisible();
  await expect(editable(page).getByText("This helper was removed")).toBeVisible();
});

test("the read-only specimen offers no comment actions", async ({ page }) => {
  await open(page);
  const specimen = readOnly(page);
  await specimen
    .getByRole("region", { name: "Diff of server/a.js" })
    .scrollIntoViewIfNeeded();
  await specimen.locator(".diff-row").nth(2).click();
  await expect(specimen.getByRole("button", { name: /Comment on line/ })).toHaveCount(0);
  for (const name of ["Edit", "Resolve", "Delete", "Reopen"])
    await expect(specimen.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(specimen.getByText("constant-time")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("long lines stay contained and the comment button is a touch target", async ({
    page,
  }) => {
    await open(page);
    const region = editable(page).getByRole("region", { name: "Diff of server/long.js" });
    await region.scrollIntoViewIfNeeded();
    await region.locator(".diff-row").nth(1).tap();
    const button = editable(page).getByRole("button", { name: "Comment on line 1" });
    await expect(button).toBeVisible();
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await region.evaluate((element) => (element.scrollLeft = 5000));
    const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
