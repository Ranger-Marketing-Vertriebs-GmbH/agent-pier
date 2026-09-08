import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
const directory = "/tmp/agentpier-test-attachments/local-claude/chat-demo";

async function fixture(page, { granted = true } = {}) {
  const session = {
    id: "chat-demo",
    name: "AgentPier entwickeln",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/home/test/agentpier",
    status: "running",
    ...(granted ? { attachments: { directory } } : {}),
  };
  const state = {
    tools: [{ id: "claude", name: "Claude Code", installed: true }],
    accounts: [
      { id: "local-claude", name: "Claude · Arbeit", tool: "claude", kind: "local" },
    ],
    sessions: [session],
    home: "/home/test",
    remoteUrl: null,
  };
  const data = {
    availability: "ready",
    providerSessionId: "native-one",
    messages: [],
    tasks: [],
  };
  const uploads = [];
  const inputs = [];
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    let result = {};
    if (p === "/api/state") result = state;
    else if (p.endsWith("/chat/attachments")) {
      const body = route.request().headers()["content-type"].includes("application/json")
        ? route.request().postDataJSON()
        : { name: new URL(route.request().url()).searchParams.get("name") };
      uploads.push(body);
      result = { name: body.name, path: `${directory}/${body.name}` };
    } else if (p.includes("/chat/images/"))
      return route.fulfill({ contentType: "image/png", body: png });
    else if (p.endsWith("/chat")) result = data;
    else if (p.endsWith("/input")) {
      const body = route.request().postDataJSON();
      inputs.push({ text: body.text, submit: body.submit });
      result = { deliveryId: body.deliveryId, status: "handed-off" };
    } else if (p.endsWith("/screen")) result = { text: "TUI_STATUS_ONLY" };
    await route.fulfill({ json: result });
  });
  await page.goto(base + "/sessions/chat-demo/chat");
  return { data, uploads, inputs };
}

test("choosing a file uploads it and shows a removable chip", async ({ page }) => {
  const f = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: png,
  });
  const chip = page.getByRole("listitem").filter({ hasText: "screenshot.png" });
  await expect(chip).toBeVisible();
  await expect.poll(() => f.uploads.length).toBe(1);
  expect(f.uploads[0].name).toBe("screenshot.png");
  expect(f.uploads[0].data).toBe(png.toString("base64"));
  // Proves the preview actually decodes as an image in the real browser,
  // under this app's real CSP (served by the test server, not stubbed) —
  // exactly the check that would have caught the blob: URL/CSP regression.
  await expect(chip.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await chip.getByRole("button", { name: "Anhang entfernen: screenshot.png" }).click();
  await expect(chip).toHaveCount(0);
});

test("dropping an image on the chat panel attaches it", async ({ page }) => {
  await fixture(page);
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const carrier = new DataTransfer();
      carrier.items.add(
        new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }),
      );
      return carrier;
    },
    [...png],
  );
  const panel = page.locator(".chat-main");
  await panel.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(panel).toHaveAttribute("data-dropping", "true");
  // dragleave bubbles at every descendant boundary while dragging across the
  // panel's interior; crossing from one child to another still inside
  // .chat-main must not disarm the overlay (it would otherwise flicker).
  await page.locator(".chat-messages").evaluate((el, dt) => {
    const other = el.closest(".chat-main").querySelector(".chat-compose-area");
    el.dispatchEvent(
      new DragEvent("dragleave", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        relatedTarget: other,
      }),
    );
  }, transfer);
  await expect(panel).toHaveAttribute("data-dropping", "true");
  await panel.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page.getByRole("listitem").filter({ hasText: "dropped.png" }),
  ).toBeVisible();
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
});

test("dragging selected text does not arm the overlay or produce an error", async ({
  page,
}) => {
  const f = await fixture(page);
  const transfer = await page.evaluateHandle(() => {
    const carrier = new DataTransfer();
    carrier.setData("text/plain", "some selected text");
    return carrier;
  });
  const panel = page.locator(".chat-main");
  await panel.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
  await panel.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByText("Nur Bilddateien können angehängt werden.")).toHaveCount(0);
  await expect(page.getByRole("listitem")).toHaveCount(0);
  expect(f.uploads).toHaveLength(0);
});

test("pasting a screenshot into the message field attaches it", async ({ page }) => {
  const f = await fixture(page);
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const carrier = new DataTransfer();
      carrier.items.add(
        new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }),
      );
      return carrier;
    },
    [...png],
  );
  // Playwright's dispatchEvent() convenience only special-cases dataTransfer
  // for drag-type events; "paste" falls back to a plain Event, which drops an
  // eventInit.clipboardData property. Build the real ClipboardEvent ourselves.
  await page.getByLabel("Nachricht").evaluate((el, dt) => {
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }),
    );
  }, transfer);
  await expect(
    page.getByRole("listitem").filter({ hasText: "pasted.png" }),
  ).toBeVisible();
  await expect.poll(() => f.uploads.length).toBe(1);
});

for (const width of [1440, 390])
  test(`existing sessions retain file uploads without a launch grant at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 500 });
    const f = await fixture(page, { granted: false });
    await page.setInputFiles('input[type="file"]', {
      name: "legacy.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(
      page.getByRole("listitem").filter({ hasText: "legacy.png" }),
    ).toBeVisible();
    await expect.poll(() => f.uploads.length).toBe(1);
    await expect(
      page.getByRole("button", { name: "Datei hinzufügen", exact: true }),
    ).toBeVisible();
  });

test("more than 8 attachments in one batch are capped with an error, and removing one reopens exactly one slot", async ({
  page,
}) => {
  const f = await fixture(page);
  const batch = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      name: `cap-${from + i}.png`,
      mimeType: "image/png",
      buffer: png,
    }));
  await page.setInputFiles('input[type="file"]', batch(1, 8));
  await expect(page.getByRole("listitem")).toHaveCount(8);
  await expect.poll(() => f.uploads.length).toBe(8);

  // A 9th file, even in its own separate selection, must still be refused:
  // the cap is derived from the real attachment list, not a per-call counter.
  await expect(
    page.getByRole("button", { name: "Datei hinzufügen", exact: true }),
  ).toBeEnabled();
  await page.setInputFiles('input[type="file"]', batch(9, 9));
  await expect(
    page.getByText("Es sind höchstens 8 Anhänge pro Nachricht möglich."),
  ).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(8);
  await expect.poll(() => f.uploads.length).toBe(8);

  // Removing one attachment must reopen exactly one slot — not two, which is
  // the symptom a double-decrementing counter would produce.
  await page
    .getByRole("listitem")
    .filter({ hasText: "cap-1.png" })
    .getByRole("button", { name: "Anhang entfernen: cap-1.png" })
    .click();
  await expect(page.getByRole("listitem")).toHaveCount(7);
  await page.setInputFiles('input[type="file"]', batch(10, 11));
  await expect(page.getByRole("listitem")).toHaveCount(8);
  await expect(
    page.getByRole("listitem").filter({ hasText: "cap-10.png" }),
  ).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "cap-11.png" })).toHaveCount(
    0,
  );
});

test("an oversized image is rejected before it is read or uploaded", async ({ page }) => {
  const f = await fixture(page);
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  await page.setInputFiles('input[type="file"]', {
    name: "huge.png",
    mimeType: "image/png",
    buffer: oversized,
  });
  await expect(
    page.getByText("Dateien dürfen höchstens 10 MiB groß sein."),
  ).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(0);
  expect(f.uploads).toHaveLength(0);
});

test("sending appends one absolute path per attachment below the text", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "shot.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByRole("listitem").filter({ hasText: "shot.png" })).toBeVisible();
  await page.getByLabel("Nachricht").fill("Warum ist das verrutscht?");
  await page.getByRole("button", { name: /senden/i }).click();
  await expect.poll(() => f.inputs.length).toBe(1);
  const [line, pathLine, ...rest] = f.inputs[0].text.split("\n");
  expect(line).toBe("Warum ist das verrutscht?");
  expect(pathLine.startsWith("/")).toBe(true);
  expect(pathLine).toMatch(/\.png$/);
  expect(rest).toHaveLength(0);
  await expect(page.getByRole("listitem").filter({ hasText: "shot.png" })).toHaveCount(0);
});

test("the sent image appears as a preview on the user's own message", async ({
  page,
}) => {
  const id = "a".repeat(64);
  const f = await fixture(page);
  f.data.messages = [
    {
      id: "u1",
      role: "user",
      text: `Warum ist das verrutscht?\n${directory}/20260908T142233-a3f1b2c4.png`,
      images: [
        {
          id,
          path: `${directory}/20260908T142233-a3f1b2c4.png`,
          url: `/api/sessions/chat-demo/chat/images/${id}`,
        },
      ],
    },
  ];
  await page.reload();
  const preview = page.getByAltText(/^Bildvorschau: /);
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty("naturalWidth", 1);
});

test("a text-only message keeps its leading and trailing whitespace exactly as typed", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByLabel("Nachricht").fill("  indented line  ");
  await page.getByRole("button", { name: /senden/i }).click();
  await expect.poll(() => f.inputs.length).toBe(1);
  expect(f.inputs[0].text).toBe("  indented line  ");
});

test("an attachment-only message with no text can be sent", async ({ page }) => {
  const f = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "only.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByRole("listitem").filter({ hasText: "only.png" })).toBeVisible();
  const send = page.getByRole("button", { name: /senden/i });
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => f.inputs.length).toBe(1);
  expect(f.inputs[0].text).toBe(`${directory}/only.png`);
  await expect(page.getByRole("listitem").filter({ hasText: "only.png" })).toHaveCount(0);
});

test("a failed send preserves the pending attachment and shows an error", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "retry.png",
    mimeType: "image/png",
    buffer: png,
  });
  const chip = page.getByRole("listitem").filter({ hasText: "retry.png" });
  await expect(chip).toBeVisible();
  await page.route("**/api/sessions/*/input", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Eingabe konnte nicht gesendet werden" },
    }),
  );
  await page.getByLabel("Nachricht").fill("Bitte nochmal versuchen");
  await page.getByRole("button", { name: /senden/i }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Eingabe konnte nicht gesendet werden",
  );
  await expect(chip).toBeVisible();
  expect(f.inputs).toHaveLength(0);
});

test("an in-flight upload blocks sending and additional drops without navigating away", async ({
  page,
}) => {
  const f = await fixture(page);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/*/chat/attachments", async (route) => {
    await gate;
    await route.fulfill({
      json: { name: "pending.png", path: `${directory}/pending.png` },
    });
  });
  await page.setInputFiles('input[type="file"]', {
    name: "pending.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    page.getByRole("button", { name: "Datei hinzufügen", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Nachricht").fill("wait for upload");
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeDisabled();
  const prevented = await page.locator(".chat-main").evaluate(
    (element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "second.png", { type: "image/png" }),
      );
      return !element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    },
    [...png],
  );
  expect(prevented).toBe(true);
  expect(f.inputs).toHaveLength(0);
  release();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem")).toContainText("pending.png");
});
