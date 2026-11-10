import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { craftRebuildsFixture, readyId, startedId } from "./craft-rebuilds-fixture.js";
import { png } from "../helpers/craft-pictures.js";

// Screenshots of the original on the Craft Anything page: a start from screenshots alone,
// screenshots of the look with a web address, removing a thumbnail before sending,
// and screenshots with a follow-up. AGENTPIER_CRAFT_REBUILDS_SCREENSHOTS names a
// folder for the screenshots of the pull request and the docs.
const screenshots = process.env.AGENTPIER_CRAFT_REBUILDS_SCREENSHOTS;
const files = {
  home: { name: "home.png", mimeType: "image/png", buffer: png(160, 100) },
  cart: {
    name: "cart.png",
    mimeType: "image/png",
    buffer: png(160, 100, [
      [70, 70, 76],
      [235, 235, 240],
      [244, 154, 88],
    ]),
  },
  notes: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
};
const starts = (state) =>
  state.calls.filter((call) => call.method === "POST" && call.path === "/craft/rebuilds");
const uploads = (state) => state.calls.filter((call) => call.path === "/craft/pictures");
const fits = (page) =>
  page.evaluate(
    () => document.scrollingElement.scrollWidth <= document.documentElement.clientWidth,
  );

for (const [device, viewport] of [
  ["desktop", { width: 1280, height: 1100 }],
  ["phone", { width: 390, height: 844 }],
])
  test(`starts a rebuild from screenshots alone (${device})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await craftRebuildsFixture(page);
    await page.goto(`${baseURL}/craft`);
    const form = page.getByRole("group", { name: "Start a rebuild" });
    await page.getByLabel("What to make").fill("A shop like these screenshots");
    await form.getByRole("radio", { name: "Screenshots" }).check();
    await expect(form.getByLabel("Web address of the target")).toHaveCount(0);
    await expect(form.getByText(/Craft Anything rebuilds what they show/)).toBeVisible();
    const picker = form.getByLabel("Choose screenshots or photos");
    await expect(picker).toHaveAttribute("accept", "image/*");
    await expect(picker).toHaveAttribute("multiple", "");
    await picker.setInputFiles([files.home, files.cart, files.notes]);
    await expect(
      page.getByText('"notes.txt" is not a PNG, JPEG, WebP or GIF picture.'),
    ).toBeVisible();
    const list = form.getByRole("list", { name: "Screenshots" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.locator("img")).toHaveCount(2);
    expect(await fits(page)).toBe(true);
    if (screenshots)
      await page.screenshot({
        path: `${screenshots}/craft-pictures-start-${device}.png`,
        fullPage: true,
      });
    // Removing a thumbnail keeps it from being sent.
    await list.getByRole("button", { name: "Remove cart.png" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    expect(uploads(state)).toHaveLength(0);

    await page.getByRole("button", { name: "Start rebuild" }).click();
    await expect(page).toHaveURL(new RegExp(`/craft/${startedId}$`));
    expect(uploads(state)).toEqual([
      { path: "/craft/pictures", method: "POST", body: { bytes: png(160, 100).length } },
    ]);
    const [id] = state.pictures.keys();
    expect([...state.pictures.values()][0].equals(png(160, 100))).toBe(true);
    expect(starts(state)).toHaveLength(1);
    expect(starts(state)[0].body).toMatchObject({
      request: "A shop like these screenshots",
      target: "-",
      pictures: [id],
    });
  });

test("adds screenshots of the look to a web address", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  const form = page.getByRole("group", { name: "Start a rebuild" });
  await page.getByLabel("What to make").fill("A to-do app");
  await expect(form.getByRole("button", { name: "Add screenshots" })).toHaveCount(0);
  await form.getByRole("radio", { name: "Web address" }).check();
  await form.getByLabel("Web address of the target").fill("https://todo.example");
  await expect(
    form.getByText(/Optional: screenshots or photos of the look/),
  ).toBeVisible();
  await form.getByLabel("Choose screenshots or photos").setInputFiles([files.cart]);
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page).toHaveURL(new RegExp(`/craft/${startedId}$`));
  expect(starts(state)[0].body).toMatchObject({
    target: "https://todo.example",
    pictures: [[...state.pictures.keys()][0]],
  });
});

test("screenshots need a picture; a start without a target sends none", async ({
  page,
}) => {
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  const form = page.getByRole("group", { name: "Start a rebuild" });
  await page.getByLabel("What to make").fill("A clock");
  await form.getByRole("radio", { name: "Screenshots" }).check();
  // Nothing to rebuild from yet.
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page.getByText("Add at least one screenshot.")).toBeVisible();
  expect(starts(state)).toHaveLength(0);
  await form.getByLabel("Choose screenshots or photos").setInputFiles([files.home]);
  // Switching back to no target leaves the picked screenshots out.
  await form.getByRole("radio", { name: "None" }).check();
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page).toHaveURL(new RegExp(`/craft/${startedId}$`));
  expect(uploads(state)).toHaveLength(0);
  expect(starts(state)[0].body).not.toHaveProperty("pictures");
  expect(starts(state)[0].body.target).toBe("-");
});

test("a follow-up carries screenshots (desktop and phone)", async ({ page }) => {
  const state = await craftRebuildsFixture(page);
  for (const viewport of [
    { width: 1280, height: 1400 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/craft/${readyId}`);
    const section = page.getByRole("region", { name: "Ask for changes" });
    await section.getByRole("textbox").fill("Make the header look like this");
    await section.getByLabel("Choose screenshots or photos").setInputFiles([files.home]);
    await expect(
      section.getByRole("list", { name: "Screenshots" }).locator("img"),
    ).toHaveCount(1);
    expect(await fits(page)).toBe(true);
    if (screenshots && viewport.width < 600)
      await page.screenshot({
        path: `${screenshots}/craft-pictures-follow-up-phone.png`,
        fullPage: true,
      });
    await section.getByRole("button", { name: "Send request" }).click();
    await expect(section.getByRole("list", { name: "Screenshots" })).toHaveCount(0);
    const followUps = state.calls.filter((call) => call.path.endsWith("/follow-up"));
    expect(followUps.at(-1).body).toEqual({
      request: "Make the header look like this",
      pictures: [[...state.pictures.keys()].at(-1)],
    });
    state.rebuilds.find((item) => item.id === readyId).status = "ready";
  }
});

test("a retry sends each picture once; dropped and abandoned pictures are deleted", async ({
  page,
}) => {
  const state = await craftRebuildsFixture(page);
  const drops = () =>
    state.calls.filter((call) => call.method === "DELETE").map((call) => call.path);
  let failing = true;
  // The second picture fails once, after the first was staged.
  state.failUpload = (bytes) => failing && bytes.equals(files.cart.buffer);
  await page.goto(`${baseURL}/craft`);
  const form = page.getByRole("group", { name: "Start a rebuild" });
  await page.getByLabel("What to make").fill("A shop");
  await form.getByRole("radio", { name: "Screenshots" }).check();
  await form
    .getByLabel("Choose screenshots or photos")
    .setInputFiles([files.home, files.cart]);
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page.getByText("The upload failed.")).toBeVisible();
  expect(starts(state)).toHaveLength(0);
  const [first] = state.pictures.keys();
  failing = false;
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page).toHaveURL(new RegExp(`/craft/${startedId}$`));
  // home.png went once, cart.png failed once and went on the retry.
  expect(uploads(state).filter((call) => !call.body.failed)).toHaveLength(2);
  expect(starts(state)[0].body.pictures).toEqual([...state.pictures.keys()]);
  expect(starts(state)[0].body.pictures[0]).toBe(first);
  expect(drops()).toEqual([]);

  // A staged picture that is removed, or left behind with the form, is deleted.
  failing = true;
  await page.goto(`${baseURL}/craft`);
  await page.getByLabel("What to make").fill("Another shop");
  await form.getByRole("radio", { name: "Screenshots" }).check();
  await form
    .getByLabel("Choose screenshots or photos")
    .setInputFiles([files.home, files.cart]);
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page.getByText("The upload failed.")).toBeVisible();
  const staged = [...state.pictures.keys()].at(-1);
  await form.getByRole("button", { name: "Remove home.png" }).click();
  await expect.poll(drops).toEqual([`/craft/pictures/${staged}`]);
  await form.getByLabel("Choose screenshots or photos").setInputFiles([files.home]);
  failing = false;
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page.getByText("The upload failed.")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/craft/${startedId}$`));
  await page.goto(`${baseURL}/craft`);
  failing = true;
  await page.getByLabel("What to make").fill("A third shop");
  await form.getByRole("radio", { name: "Screenshots" }).check();
  await form
    .getByLabel("Choose screenshots or photos")
    .setInputFiles([files.home, files.cart]);
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page.getByText("The upload failed.")).toBeVisible();
  const abandoned = [...state.pictures.keys()].at(-1);
  await page.getByRole("link", { name: /timer/ }).click();
  await expect.poll(drops).toContain(`/craft/pictures/${abandoned}`);
});
