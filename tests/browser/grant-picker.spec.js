import { test, expect } from "../helpers/browser-test.js";

// GrantPicker (docs/ui-guide.md#choosing-what-a-session-may-use) in Settings ›
// Operations › Development › Components: 600 SSH accesses, prod-web-01 granted and
// prod-web-02 managed by the project.
test.use({ locale: "en-GB" });

async function specimen(page, label) {
  await page.goto("/settings/components");
  const box = page
    .locator(".gallery-specimen")
    .filter({ has: page.getByText(label, { exact: true }) });
  await expect(box.locator(".grant-picker")).toBeVisible();
  return box;
}

const split = (page) => specimen(page, "GrantPicker · split · 600 items");

test("split: typing finds an entry far down, checking it shows it as allowed", async ({
  page,
}) => {
  const box = await split(page);
  const search = box.getByRole("searchbox", { name: "Search SSH accesses" });
  const choices = box.getByRole("group", { name: "SSH accesses" });
  const allowed = box.getByRole("group", { name: /^Allowed in this session/ });
  await expect(search).not.toBeFocused();
  await search.fill("dev-logs-50");
  await expect(box.getByRole("status")).toHaveText("1 of 600");
  await expect(choices.getByRole("checkbox")).toHaveCount(1);

  await choices.getByRole("checkbox", { name: "dev-logs-50" }).check();
  await expect(allowed.getByText("dev-logs-50", { exact: true })).toBeVisible();
  await expect(
    box.getByRole("heading", { name: "Allowed in this session · 3" }),
  ).toBeVisible();

  await search.fill("");
  await search.fill("stage");
  await expect(box.getByRole("status")).toHaveText("200 of 600");
  await expect(allowed.getByText("dev-logs-50", { exact: true })).toBeVisible();

  await allowed.getByRole("button", { name: "Remove dev-logs-50" }).click();
  await expect(allowed.getByText("dev-logs-50", { exact: true })).toHaveCount(0);
  await expect(
    box.getByRole("heading", { name: "Allowed in this session · 2" }),
  ).toBeVisible();
});

test("split: 600 entries render 50 rows and count the rest", async ({ page }) => {
  const box = await split(page);
  const choices = box.getByRole("group", { name: "SSH accesses" });
  await expect(choices.getByRole("checkbox")).toHaveCount(50);
  await expect(box.getByText("550 more – refine the search")).toBeVisible();
  await expect(box.getByRole("status")).toHaveText("600 of 600");
});

test("split: a locked entry is checked, disabled and has no remove button", async ({
  page,
}) => {
  const box = await split(page);
  const locked = box
    .getByRole("group", { name: "SSH accesses" })
    .getByRole("checkbox", { name: "prod-web-02" });
  await expect(locked).toBeChecked();
  await expect(locked).toBeDisabled();
  const allowed = box.getByRole("group", { name: /^Allowed in this session/ });
  await expect(allowed.getByText("Project managed")).toBeVisible();
  await expect(allowed.getByRole("button", { name: "Remove prod-web-01" })).toBeVisible();
  await expect(box.getByRole("button", { name: "Remove prod-web-02" })).toHaveCount(0);
});

test("split: a search without matches says so with the query", async ({ page }) => {
  const box = await split(page);
  await box.getByRole("searchbox", { name: "Search SSH accesses" }).fill("zzz");
  await expect(box.getByText("No matches for “zzz”")).toBeVisible();
  await expect(box.getByRole("status")).toHaveText("0 of 600");
  await expect(box.getByRole("checkbox")).toHaveCount(0);
});

test("split: a disabled picker cannot be changed", async ({ page }) => {
  const box = await specimen(page, "GrantPicker · disabled");
  const choices = box.getByRole("group", { name: "SSH accesses" });
  await expect(choices.getByRole("checkbox", { name: "prod-web-01" })).toBeDisabled();
  await expect(choices.getByRole("checkbox", { name: "prod-web-03" })).toBeDisabled();
  await expect(box.getByRole("button", { name: "Remove prod-web-01" })).toBeDisabled();
  // The search stays usable.
  const search = box.getByRole("searchbox", { name: "Search SSH accesses" });
  await search.fill("prod-web-03");
  await expect(box.getByRole("status")).toHaveText("1 of 600");
});

test("stacked: the add field grants and the row's button removes", async ({ page }) => {
  const box = await specimen(page, "GrantPicker · stacked");
  await expect(box.locator(".grant-picker")).toHaveAttribute(
    "data-arrangement",
    "stacked",
  );
  const card = box.getByRole("group", { name: "SSH accesses of the sample session" });
  const field = card.getByRole("combobox", { name: "Add SSH access" });
  await field.fill("stage-db-07");
  const list = card.getByRole("listbox", { name: "SSH access: options" });
  await list.getByRole("option", { name: /stage-db-07/ }).click();
  await card.getByRole("button", { name: "Add 1" }).click();
  await expect(card.getByText("stage-db-07", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Remove stage-db-07" }).click();
  await expect(card.getByText("stage-db-07", { exact: true })).toHaveCount(0);

  await field.fill("prod-web-0");
  const granted = list.getByRole("option", { name: /prod-web-01/ });
  await expect(granted).toHaveAttribute("aria-disabled", "true");
  await expect(granted).toContainText("allowed");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the split specimen stacks at phone width", async ({ page }) => {
    const box = await split(page);
    await expect(box.locator(".grant-picker")).toHaveAttribute(
      "data-arrangement",
      "stacked",
    );
    await expect(box.getByRole("combobox", { name: "Add SSH access" })).toBeVisible();
    await expect(box.getByRole("searchbox")).toHaveCount(0);
  });
});
