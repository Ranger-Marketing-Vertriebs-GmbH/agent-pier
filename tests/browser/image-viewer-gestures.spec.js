import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// A square image: at 2× it is wider than a phone's stage but no taller, so it pans
// sideways only.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">' +
  '<rect width="1000" height="1000" fill="teal"/></svg>';
const messages = [
  {
    id: "shared-file:img",
    role: "assistant",
    text: "The chart",
    timestamp: 2,
    runId: null,
    shared: true,
    attachments: [
      { id: "img", name: "chart.png", type: "image/png", kind: "image", size: 68 },
    ],
  },
];

async function open(page) {
  await chatFixture(page, { history: { messages, requests: [], stale: false } });
  await page.route(/\/api\/assistant-attachments\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg }),
  );
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.getByRole("log").getByRole("button", { name: "Open chart.png" }).click();
  const viewer = page.getByRole("dialog", { name: "Image viewer" });
  const image = viewer.getByRole("img", { name: "chart.png" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node) => node.naturalWidth)).toBe(1000);
  return { viewer, image };
}

// Where the image is drawn, relative to the stage's centre, and its rest width.
const place = (page) =>
  page.evaluate(() => {
    const stage = document.querySelector(".image-viewer-stage").getBoundingClientRect();
    const image = document.querySelector(".image-viewer-stage img");
    const box = image.getBoundingClientRect();
    return {
      x: box.left + box.width / 2 - (stage.left + stage.width / 2),
      y: box.top + box.height / 2 - (stage.top + stage.height / 2),
      scale: box.width / image.offsetWidth,
      left: box.left - stage.left,
      right: box.right - stage.right,
      centre: { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 },
    };
  });

// Synthetic touch pointers run the viewer's own handlers in both engines; neither
// engine's emulation can replay a native multi-finger gesture. Each step is a list of
// [type, id, x, y] relative to the stage's centre, dispatched on the image.
const touch = (page, steps) =>
  page.evaluate((steps) => {
    const stage = document.querySelector(".image-viewer-stage").getBoundingClientRect();
    const image = document.querySelector(".image-viewer-stage img");
    for (const [type, id, x, y] of steps)
      image.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: id,
          pointerType: "touch",
          isPrimary: id === 1,
          button: type === "pointermove" ? -1 : 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: stage.left + stage.width / 2 + x,
          clientY: stage.top + stage.height / 2 + y,
        }),
      );
  }, steps);

// Two fingers spread from 40 to 160 apart around (50, 40) by the stage's centre.
const pinch = [
  ["pointerdown", 1, 30, 40],
  ["pointerdown", 2, 70, 40],
  ...[0.25, 0.5, 0.75, 1].flatMap((t) => [
    ["pointermove", 1, 30 - 60 * t, 40],
    ["pointermove", 2, 70 + 60 * t, 40],
  ]),
  ["pointerup", 2, 130, 40],
  ["pointerup", 1, -30, 40],
];
const drag = (id, from, to) => [
  ["pointerdown", id, ...from],
  ...[0.25, 0.5, 0.75, 1].map((t) => [
    "pointermove",
    id,
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
  ]),
  ["pointerup", id, ...to],
];
const tap = (id, x, y) => [
  ["pointerdown", id, x, y],
  ["pointerup", id, x, y],
];

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a pinch zooms around the fingers and one finger pans within the edges", async ({
    page,
  }) => {
    const { viewer } = await open(page);
    await touch(page, pinch);
    let now = await place(page);
    expect(now.scale).toBeCloseTo(4, 1);
    // The image point under the fingers (50, 40) stays under them.
    expect(now.x).toBeCloseTo(-150, 0);
    expect(now.y).toBeCloseTo(-120, 0);
    // Dragged far right, the image stops with its left edge at the stage's edge.
    await touch(page, drag(3, [0, 0], [2000, 0]));
    now = await place(page);
    expect(now.left).toBeCloseTo(0, 0);
    await touch(page, drag(4, [0, 0], [-4000, 0]));
    expect((await place(page)).right).toBeCloseTo(0, 0);
    // A swipe down while zoomed pans and never closes.
    await touch(page, drag(5, [0, -200], [0, 400]));
    await expect(viewer).toBeVisible();
  });

  test("a double tap zooms to 2× at the tap and back", async ({ page }) => {
    await open(page);
    await touch(page, [...tap(1, 60, 20), ...tap(2, 60, 20)]);
    let now = await place(page);
    expect(now.scale).toBeCloseTo(2, 2);
    expect(now.x).toBeCloseTo(-60, 0);
    // A square image twice the stage's width is still no taller than the stage.
    expect(now.y).toBeCloseTo(0, 0);
    await touch(page, [...tap(3, 0, 0), ...tap(4, 0, 0)]);
    now = await place(page);
    expect(now.scale).toBeCloseTo(1, 2);
    expect(now.x).toBeCloseTo(0, 0);
  });

  test("a swipe down closes at 1× and a new viewer starts unzoomed", async ({ page }) => {
    const { viewer } = await open(page);
    await touch(page, [...tap(1, 0, 0), ...tap(2, 0, 0)]);
    expect((await place(page)).scale).toBeCloseTo(2, 2);
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await page.getByRole("log").getByRole("button", { name: "Open chart.png" }).click();
    await expect(viewer).toBeVisible();
    expect((await place(page)).scale).toBeCloseTo(1, 2);
    // A short pull springs back; a long one closes.
    await touch(page, drag(3, [0, 0], [0, 60]));
    await expect(viewer).toBeVisible();
    expect((await place(page)).y).toBeCloseTo(0, 0);
    await touch(page, drag(4, [0, 0], [0, 160]));
    await expect(viewer).toHaveCount(0);
  });
});

test.describe("desktop", () => {
  test("double click, ctrl + wheel and a mouse drag zoom and pan", async ({ page }) => {
    const { viewer, image } = await open(page);
    const { centre } = await place(page);
    await page.mouse.dblclick(centre.x + 100, centre.y);
    let now = await place(page);
    expect(now.scale).toBeCloseTo(2, 2);
    expect(now.x).toBeCloseTo(-100, 0);
    // A drag pans and stops at the image's edge; it does not close the viewer.
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 3000, centre.y + 3000, { steps: 4 });
    await page.mouse.up();
    now = await place(page);
    expect(now.left).toBeCloseTo(0, 0);
    await expect(viewer).toBeVisible();
    await page.mouse.dblclick(centre.x, centre.y);
    expect((await place(page)).scale).toBeCloseTo(1, 2);
    // Trackpad pinches arrive as wheel events with ctrlKey set.
    await image.dispatchEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100 * Math.log(3),
      clientX: centre.x,
      clientY: centre.y,
    });
    expect((await place(page)).scale).toBeCloseTo(3, 1);
    // A click on the image keeps the viewer open.
    await page.mouse.click(centre.x, centre.y);
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });
});
