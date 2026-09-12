import { test, expect } from "@playwright/test";
import { fixture, createForm } from "./providers-fixture.js";

test("keyboard selection keeps long-catalog results below the search input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  const controls = await fixture(page);
  const seed = controls.catalogs.openrouter[0];
  controls.catalogs.openrouter = Array.from({ length: 40 }, (_, index) => ({
    ...seed,
    modelId: `example/model-${index}`,
    label: `Model ${index}`,
  }));
  await createForm(page, "opencode", controls);
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  const model = page.getByLabel("Anbietermodell", { exact: true });
  await model.click();
  const search = page.getByRole("combobox", { name: "Modelle suchen", exact: true });
  await search.fill("model");
  for (let index = 0; index < 20; index++) await search.press("ArrowDown");
  for (let index = 0; index < 8; index++) {
    await search.press("ArrowUp");
    await expect
      .poll(async () => {
        const option = page.locator(
          `[id="${await search.getAttribute("aria-activedescendant")}"]`,
        );
        const row = await option.boundingBox(),
          field = await search.boundingBox();
        return row.y - field.y - field.height;
      })
      .toBeGreaterThanOrEqual(0);
  }
  await search.press("Enter");
  await expect(model).toHaveValue("example/model-11");
});

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`provider model selection leaves IME keys to composition ${JSON.stringify(composition)}`, async ({
    page,
  }) => {
    const controls = await fixture(page);
    await createForm(page, "opencode", controls);
    await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
    const model = page.getByLabel("Anbietermodell", { exact: true });
    await model.selectOption("z-ai/glm-5.3");
    await model.click();
    const search = page.getByRole("combobox", { name: "Modelle suchen", exact: true });
    await search.fill("unknown");
    await search.press("ArrowDown");
    for (const key of ["Enter", "Escape", "ArrowUp", "ArrowDown"]) {
      const untouched = await search.evaluate(
        (element, event) =>
          element.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...event }),
          ),
        { key, ...composition },
      );
      expect(untouched).toBe(true);
      await expect(search).toBeVisible();
      await expect(model).toHaveValue("z-ai/glm-5.3");
    }
    await search.press("Enter");
    await expect(model).toHaveValue("example/unknown");
    await expect(search).toHaveCount(0);
    const untouched = await model.evaluate(
      (element, event) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "u",
            ...event,
          }),
        ),
      composition,
    );
    expect(untouched).toBe(true);
    await expect(search).toHaveCount(0);
    expect(controls.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 500 },
]) {
  test(`provider models use one searchable dropdown at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const controls = await fixture(page);
    await createForm(page, "opencode", controls);
    controls.holdProvider = "openrouter";
    await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
    const model = page.getByLabel("Anbietermodell", { exact: true });
    const search = page.getByRole("combobox", { name: "Modelle suchen", exact: true });
    await expect(model).toBeDisabled();
    await expect.poll(() => Boolean(controls.release)).toBe(true);
    controls.holdProvider = null;
    controls.release();
    await expect(model).toBeEnabled();
    await expect(page.getByLabel("Modelle suchen", { exact: true })).toHaveCount(0);
    await expect(model).toHaveValue("");
    expect(await model.evaluate((element) => element.validity.valueMissing)).toBe(true);
    await model.click();
    await expect(search).toBeFocused();
    await search.fill("z-ai/glm");
    const list = page.getByRole("listbox", { name: "Anbietermodell: Optionen" });
    await expect(list.getByRole("option")).toHaveCount(1);
    await search.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(model).toHaveValue("");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(model).toHaveValue("z-ai/glm-5.3");
    await expect(model).toBeFocused();
    await expect(search).toHaveCount(0);
    await model.press("ArrowDown");
    await search.fill("not-a-real-model");
    await expect(list.getByRole("option")).toHaveCount(0);
    await expect(
      list.getByText("Keine passenden Modelle für diese CLI gefunden."),
    ).toBeVisible();
    await search.press("Enter");
    await expect(model).toHaveValue("z-ai/glm-5.3");
    await search.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(model).toBeFocused();
    await model.press("u");
    await expect(search).toHaveValue("u");
    await search.pressSequentially("nknown");
    const panel = page.locator(".anchored-options");
    const box = await panel.boundingBox();
    const dialog = await page.getByRole("dialog").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(dialog.x);
    expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(Math.max(0, dialog.y));
    expect(box.y + box.height).toBeLessThanOrEqual(
      Math.min(viewport.height, dialog.y + dialog.height),
    );
    await page.screenshot({
      path: testInfo.outputPath("searchable-provider-models.png"),
      animations: "disabled",
    });
    await list.getByRole("option", { name: "Unknown limits · example/unknown" }).click();
    await expect(model).toHaveValue("example/unknown");
    expect(controls.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    controls.failRefresh = true;
    await page.getByRole("button", { name: "Modellkatalog aktualisieren" }).click();
    await expect(page.getByRole("alert")).toContainText("Fixture catalog unavailable");
    await expect(model).toHaveValue("example/unknown");
  });
}
