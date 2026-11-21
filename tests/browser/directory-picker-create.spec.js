import { test, expect } from "../helpers/browser-test.js";
import { openNewSession } from "../helpers/navigation.js";
import { fixture } from "./ssh-fixture.js";

// AGENTPIER-461: the folder picker's "Create directory" form keeps the picker's inset
// and stays clear of the sticky "Back / Use this directory" footer, wherever the
// picker opens.
const refusal = "Please enter a single folder name without a path.";

async function routes(page) {
  await fixture(page);
  await page.route("**/api/pipeline-profiles", (route) =>
    route.fulfill({ json: { profiles: [] } }),
  );
  await page.route("**/api/directories**", (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({ status: 400, json: { error: refusal } });
    const path = new URL(route.request().url()).searchParams.get("path") || "/home/test";
    return route.fulfill({
      json: {
        path,
        parent: "/",
        entries: Array.from({ length: 14 }, (_, index) => ({
          name: `folder-${index + 1}`,
          path: `${path}/folder-${index + 1}`,
        })),
      },
    });
  });
}

/** Every box lies inside the picker's inset and above its sticky footer, uncovered. */
async function clearOfFooter(page, picker, targets) {
  const footer = await picker.locator(":scope > .dialog-actions").boundingBox();
  const frame = await picker.boundingBox();
  for (const target of targets) {
    await expect(target).toBeInViewport();
    const box = await target.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y + 1);
    expect(box.x).toBeGreaterThanOrEqual(frame.x + 16);
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width - 16);
    const hit = await target.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const top = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return node.contains(top);
    });
    expect(hit).toBe(true);
  }
}

async function createAndRefuse(page, picker) {
  await picker.getByRole("button", { name: "Create directory", exact: true }).click();
  const name = picker.getByLabel("Directory name", { exact: true });
  await expect(name).toBeFocused();
  await name.fill("a/b");
  await name.press("Enter");
  const form = picker.locator(".create-directory");
  await expect(form.getByRole("alert")).toHaveText(refusal);
  await clearOfFooter(page, picker, [
    name,
    form.getByRole("button", { name: "Cancel", exact: true }),
    form.getByRole("button", { name: "Create directory", exact: true }),
    form.getByRole("alert"),
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
}

test.use({ locale: "en-GB" });

for (const width of [1280, 390, 320]) {
  test(`settings: the create form stays styled and visible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 700 ? 900 : 700 });
    await routes(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Choose default directory" }).click();
    const picker = page.getByRole("dialog").locator(".directory-picker");
    await expect(
      picker.getByRole("button", { name: "folder-1", exact: true }),
    ).toBeVisible();
    await createAndRefuse(page, picker);
    await page.screenshot({ path: test.info().outputPath(`settings-${width}.png`) });
  });

  test(`new session: the create form stays styled and visible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 700 ? 900 : 700 });
    await routes(page);
    await page.goto("/");
    await openNewSession(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Choose directory", exact: true }).click();
    const picker = dialog.locator(".directory-picker");
    await expect(
      picker.getByRole("button", { name: "folder-1", exact: true }),
    ).toBeVisible();
    await createAndRefuse(page, picker);
    await page.screenshot({ path: test.info().outputPath(`launch-${width}.png`) });
  });
}

test("clone form: the picker's create form stays clear of its footer at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await routes(page);
  await page.route("**/api/repositories", (route) =>
    route.fulfill({ json: { credentials: [], projects: [] } }),
  );
  for (const [path, json] of [
    ["project-groups", { groups: [] }],
    ["agentbus**", { peers: [], projects: [] }],
  ])
    await page.route(`**/api/${path}`, (route) => route.fulfill({ json }));
  await page.goto("/projects");
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("menuitem", { name: /Clone repository/ }).click();
  await page
    .getByRole("dialog", { name: "Clone repository" })
    .getByRole("button", { name: "Choose directory", exact: true })
    .click();
  const picker = page
    .getByRole("dialog", { name: "Parent directory" })
    .locator(".directory-picker");
  await expect(
    picker.getByRole("button", { name: "folder-1", exact: true }),
  ).toBeVisible();
  await createAndRefuse(page, picker);
});
