import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// A tall screenshot, 800 × 4000: at fit size it is far narrower than any stage, and
// zoomed it is many stages tall, so its top and bottom edges are reached only by panning.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="4000">' +
  '<rect width="800" height="4000" fill="teal"/>' +
  '<rect y="3900" width="800" height="100" fill="orange"/></svg>';
const messages = [
  {
    id: "shared-file:tall",
    role: "assistant",
    text: "The page",
    timestamp: 2,
    runId: null,
    shared: true,
    attachments: [
      { id: "tall", name: "page.png", type: "image/png", kind: "image", size: 68 },
    ],
  },
];

async function open(page) {
  await chatFixture(page, { history: { messages, requests: [], stale: false } });
  await page.route(/\/api\/assistant-attachments\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg }),
  );
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.getByRole("log").getByRole("button", { name: "Open page.png" }).click();
  const viewer = page.getByRole("dialog", { name: "Image viewer" });
  const image = viewer.getByRole("img", { name: "page.png" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node) => node.naturalHeight)).toBe(4000);
  return { viewer, image };
}

// The drawn image's edges against the stage's (positive `top`: a gap above the image;
// negative `bottom`: the image ends above the stage's bottom), and its scale.
const place = (page) =>
  page.evaluate(() => {
    const stage = document.querySelector(".image-viewer-stage").getBoundingClientRect();
    const image = document.querySelector(".image-viewer-stage img");
    const box = image.getBoundingClientRect();
    return {
      top: box.top - stage.top,
      bottom: box.bottom - stage.bottom,
      left: box.left - stage.left,
      right: box.right - stage.right,
      width: box.width,
      stageWidth: stage.width,
      scale: box.width / image.offsetWidth,
      centre: { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 },
    };
  });

test.describe("desktop", () => {
  test("a tall image fits at rest; a double click fills the width from the top and wheel or drag reach the bottom", async ({
    page,
  }) => {
    const { viewer } = await open(page);
    let now = await place(page);
    // At rest the whole image is inside the stage.
    expect(now.top).toBeGreaterThanOrEqual(-0.5);
    expect(now.bottom).toBeLessThanOrEqual(0.5);
    const { centre } = now;
    // A long screenshot is a thin strip at rest: a double click fills the stage's width
    // with it, from its top edge.
    await page.mouse.dblclick(centre.x, centre.y);
    await expect
      .poll(async () => (await place(page)).width)
      .toBeCloseTo(now.stageWidth, 0);
    now = await place(page);
    expect(now.left).toBeCloseTo(0, 0);
    expect(now.top).toBeCloseTo(0, 0);
    const fit = now.scale;
    expect(fit).toBeGreaterThan(4);
    // Wheel (or trackpad) scrolling pans down to the bottom edge and not beyond.
    await page.mouse.move(centre.x, centre.y);
    for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, 400);
    await expect.poll(async () => (await place(page)).bottom).toBeCloseTo(0, 0);
    expect((await place(page)).scale).toBeCloseTo(fit, 2);
    for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, -400);
    await expect.poll(async () => (await place(page)).top).toBeCloseTo(0, 0);
    // A drag upward reaches the bottom edge too.
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x, centre.y - 12000, { steps: 6 });
    await page.mouse.up();
    now = await place(page);
    expect(now.bottom).toBeCloseTo(0, 0);
    await expect(viewer).toBeVisible();
    // Zooming on stops at twice the fit-to-width size, past the usual 4×.
    // Trackpad pinches arrive as wheel events with ctrlKey set.
    for (let i = 0; i < 4; i += 1)
      await page.locator(".image-viewer-stage img").dispatchEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -200,
        clientX: centre.x,
        clientY: centre.y,
      });
    await expect.poll(async () => (await place(page)).scale).toBeCloseTo(2 * fit, 1);
    expect((await place(page)).width).toBeCloseTo(2 * now.stageWidth, 0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // Synthetic touch pointers on the image, at [type, id, x, y] from the stage's centre.
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

  test("a pinch and one-finger pans reach the top and bottom edges", async ({ page }) => {
    await open(page);
    let now = await place(page);
    expect(now.top).toBeGreaterThanOrEqual(-0.5);
    expect(now.bottom).toBeLessThanOrEqual(0.5);
    // Two fingers spread from 40 to 160 apart: 4×.
    await touch(page, [
      ["pointerdown", 1, -20, 0],
      ["pointerdown", 2, 20, 0],
      ...[0.25, 0.5, 0.75, 1].flatMap((t) => [
        ["pointermove", 1, -20 - 60 * t, 0],
        ["pointermove", 2, 20 + 60 * t, 0],
      ]),
      ["pointerup", 2, 80, 0],
      ["pointerup", 1, -80, 0],
    ]);
    expect((await place(page)).scale).toBeCloseTo(4, 1);
    for (let i = 0; i < 6; i += 1) await touch(page, drag(10 + i, [0, 300], [0, -300]));
    now = await place(page);
    expect(now.bottom).toBeCloseTo(0, 0);
    for (let i = 0; i < 6; i += 1) await touch(page, drag(20 + i, [0, -300], [0, 300]));
    now = await place(page);
    expect(now.top).toBeCloseTo(0, 0);
  });

  test("a double tap fills the width from the top and one finger reaches the bottom", async ({
    page,
  }) => {
    await open(page);
    let now = await place(page);
    expect(now.width).toBeLessThan(now.stageWidth / 2);
    await touch(page, [
      ["pointerdown", 1, 20, 100],
      ["pointerup", 1, 20, 100],
      ["pointerdown", 2, 20, 100],
      ["pointerup", 2, 20, 100],
    ]);
    now = await place(page);
    expect(now.width).toBeCloseTo(now.stageWidth, 0);
    expect(now.left).toBeCloseTo(0, 0);
    expect(now.top).toBeCloseTo(0, 0);
    for (let i = 0; i < 6; i += 1) await touch(page, drag(10 + i, [0, 300], [0, -300]));
    now = await place(page);
    expect(now.bottom).toBeCloseTo(0, 0);
    expect(now.width).toBeCloseTo(now.stageWidth, 0);
  });
});
