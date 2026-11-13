import { test, expect } from "../helpers/browser-test.js";
import {
  fixture,
  openCloneDialog,
  openRepositories,
} from "../helpers/repository-browser.js";

// iOS Safari keeps the layout viewport when its keyboard opens and shrinks only the
// visual viewport, so a bottom sheet fixed to the bottom edge would sit behind the
// keyboard. web/lib/keyboard-inset.js lifts every dialog above it.
test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

async function keyboard(page, { height, top = 0 }) {
  await page.evaluate(
    ({ height, top }) => {
      const viewport = window.visualViewport;
      Object.defineProperty(viewport, "height", { configurable: true, value: height });
      Object.defineProperty(viewport, "offsetTop", { configurable: true, value: top });
      viewport.dispatchEvent(new Event("resize"));
    },
    { height, top },
  );
}

const bottom = (box) => box.y + box.height;

async function openOrganizationSearch(page) {
  await fixture(page);
  await page.route("**/api/repositories/discover?*", (route) =>
    route.fulfill({
      json: {
        organizations: ["Acme", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map(
          (login) => ({ login }),
        ),
        repositories: [],
        total: 0,
        page: 1,
        hasMore: false,
        truncated: false,
      },
    }),
  );
  await openRepositories(page);
  const dialog = await openCloneDialog(page);
  await dialog.getByRole("radio", { name: /Persönlich/ }).check();
  await page.getByRole("button", { name: "Organisation", exact: true }).tap();
  const search = page.getByRole("combobox", { name: "Organisation suchen" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("option", { name: "Acme", exact: true })).toBeVisible();
  return { dialog, search };
}

test("a bottom sheet sits on the keyboard and keeps the focused search visible", async ({
  page,
}) => {
  const { dialog, search } = await openOrganizationSearch(page);
  // A filter field must not offer contact autofill.
  await expect(search).toHaveAttribute("autocomplete", "off");
  await expect.poll(async () => Math.round(bottom(await dialog.boundingBox()))).toBe(844);

  // The keyboard and its accessory bar take the lower 380px.
  await keyboard(page, { height: 464 });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-open", "");
  await expect.poll(async () => Math.round(bottom(await dialog.boundingBox()))).toBe(464);
  const sheet = await dialog.boundingBox();
  expect(sheet.y).toBeGreaterThanOrEqual(0);
  // The search and the first organization show between the sheet's heading and its
  // actions, once the sheet has scrolled them into view.
  const heading = bottom(await dialog.locator(".dialog-heading").boundingBox());
  const actions = (await dialog.locator(".dialog-actions").boundingBox()).y;
  const acme = page.getByRole("option", { name: "Acme", exact: true });
  await expect
    .poll(async () => {
      const field = await search.boundingBox();
      const option = await acme.boundingBox();
      return field.y >= heading && bottom(option) <= actions;
    })
    .toBe(true);

  // iOS may also pan the visible area up: the sheet follows it and stays below its top.
  await keyboard(page, { height: 464, top: 120 });
  await expect.poll(async () => Math.round(bottom(await dialog.boundingBox()))).toBe(584);
  expect((await dialog.boundingBox()).y).toBeGreaterThanOrEqual(120);

  // The keyboard closes: back to the bottom edge, the root carries no keyboard state.
  await keyboard(page, { height: 844 });
  await expect.poll(async () => Math.round(bottom(await dialog.boundingBox()))).toBe(844);
  await expect(page.locator("html")).not.toHaveAttribute("data-keyboard-open");
});

test("the home indicator padding of a sheet does not stack on the keyboard", async ({
  page,
}) => {
  const { dialog } = await openOrganizationSearch(page);
  // Emulates an iPhone's home indicator where a device sets it: the token's default.
  await page.addStyleTag({ content: ":root { --safe-area-inset-bottom: 34px; }" });
  const footer = dialog.locator(".dialog-actions");
  const padding = async () =>
    parseFloat(
      await footer.evaluate((element) => getComputedStyle(element).paddingBottom),
    );
  await expect.poll(padding).toBe(50);
  await keyboard(page, { height: 464 });
  await expect.poll(padding).toBe(16);
});
