import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A 160×110 gradient, so thumbnails and screenshots show a real picture.
function gradientPng(width = 160, height = 110) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++)
      row.push(240 - y, 120 + Math.round((x / width) * 100), 60 + Math.round(y / 2));
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const png = gradientPng();
const shots = process.env.AGENTPIER_ATTACHMENT_SHOTS;
const words = {
  en: {
    options: "Options",
    attach: "Attach file or image",
    team: "Allow a team for this message",
    list: "Attachments",
    sent: "Attached files",
    remove: (name) => `Remove ${name}`,
    download: (name) => `Download ${name}`,
    send: "Send",
    tooLarge: '"huge.png" is larger than 10 MB.',
    unsupported: /"tool\.exe" is not supported/,
    serverUnsupported: "This file type is not supported.",
    noImages: "This agent's model can't see images.",
  },
  de: {
    options: "Optionen",
    attach: "Datei oder Bild anhängen",
    team: "Ein Team für diese Nachricht erlauben",
    list: "Anhänge",
    sent: "Angehängte Dateien",
    remove: (name) => `${name} entfernen`,
    download: (name) => `${name} herunterladen`,
    send: "Senden",
    tooLarge: "„huge.png“ ist größer als 10 MB.",
    unsupported: /„tool\.exe“ wird nicht unterstützt/,
    serverUnsupported: "Dieser Dateityp wird nicht unterstützt.",
    noImages: "Das Modell dieses Agenten kann keine Bilder sehen.",
  },
};
const unsupportedProblem = {
  error:
    "Dieser Dateityp wird nicht unterstützt. Erlaubt sind Bilder (JPEG, PNG, WebP, GIF, HEIC), PDF und Textdateien.",
  messageKey: "assistants.attachmentUnsupported",
};
const viewports = [
  { name: "desktop", width: 1280, height: 860 },
  { name: "phone", width: 390, height: 844 },
];

// Answers the attachment routes like the server: uploads by name, the policy and
// image bytes. A name containing "reject" is refused like a renamed binary.
async function attachmentRoutes(page, state, { imageInput = true } = {}) {
  state.uploads = [];
  state.deleted = [];
  await page.route(/\/api\/assistant-(?:conversations|attachments)\//, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/attachment-policy"))
      return route.fulfill({ json: { imageInput, maxBytes: 10485760, maxFiles: 5 } });
    if (url.pathname.endsWith("/attachments") && method === "POST") {
      const name = url.searchParams.get("name");
      if (name.includes("reject"))
        return route.fulfill({ status: 415, json: unsupportedProblem });
      const id = `file-${state.uploads.length + 1}`;
      const body = route.request().postDataBuffer();
      state.uploads.push({ id, name, size: body?.length ?? 0, path: url.pathname });
      const image = /\.png$/i.test(name);
      return route.fulfill({
        status: 201,
        json: {
          id,
          name,
          size: body?.length ?? 0,
          type: image ? "image/png" : "text/plain",
          kind: image ? "image" : "text",
        },
      });
    }
    if (method === "DELETE") {
      state.deleted.push(url.pathname.split("/").at(-1));
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname.startsWith("/api/assistant-attachments/"))
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    return route.fallback();
  });
}

function tempFiles(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attachments-spec-"));
  t.cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  const write = (name, body) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, body);
    return file;
  };
  return {
    photo: write("photo.png", png),
    notes: write("notes.md", "# Shopping\n- rice\n"),
    huge: write("huge.png", Buffer.alloc(10 * 1024 * 1024 + 1)),
    tool: write("tool.exe", "MZ"),
    rejected: write("reject.txt", "renamed binary"),
  };
}

async function pick(page, w, files) {
  await page.getByRole("button", { name: w.options, exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: w.attach }).click();
  await (await chooser).setFiles(files);
}

const member = chatAssistant({
  id: "member-0",
  name: "Research lead",
  teamMemberId: "member-0",
});

for (const language of ["en", "de"])
  for (const viewport of viewports)
    test(`${language} ${viewport.name}: files go to the lead and to a member and stay in the history`, async ({
      page,
    }) => {
      const w = words[language];
      const t = {};
      const files = tempFiles(t);
      try {
        await page.setViewportSize(viewport);
        const state = await chatFixture(page, {
          language,
          assistants: [chatAssistant(), member],
          conversations: [
            { id: "dinner", assistantId: "home" },
            { id: "member-chat", assistantId: "member-0" },
          ],
        });
        await attachmentRoutes(page, state);
        await page.goto(baseURL + "/agents/home/chats/dinner");

        // The lead's "+" offers the files next to the team permission.
        await page.getByRole("button", { name: w.options, exact: true }).click();
        await expect(page.getByRole("button", { name: w.attach })).toBeVisible();
        await expect(page.getByRole("switch", { name: w.team })).toBeVisible();
        await page.keyboard.press("Escape");

        await pick(page, w, [files.photo, files.notes]);
        const tray = page.getByRole("list", { name: w.list });
        await expect(tray.getByRole("listitem")).toHaveCount(2);
        await expect(tray.locator("img")).toHaveCount(1);
        await expect(tray.getByText("notes.md")).toBeVisible();
        await expect(page.getByRole("button", { name: w.send })).toBeEnabled();
        if (shots && language === "en")
          await page.screenshot({
            path: path.join(shots, `lead-composer-${viewport.name}.png`),
          });
        // Removing a picked file discards it on the server too.
        await pick(page, w, [files.rejected]);
        await expect(tray.getByRole("alert")).toContainText(w.serverUnsupported);
        await expect(page.getByRole("button", { name: w.send })).toBeDisabled();
        await tray.getByRole("button", { name: w.remove("reject.txt") }).click();
        await page.locator("#assistant-message").fill("What can I cook with this?");
        await page.getByRole("button", { name: w.send }).click();
        await expect.poll(() => state.posted.length).toBe(1);
        expect(state.posted[0].text).toBe("What can I cook with this?");
        expect(state.posted[0].attachments).toEqual(["file-1", "file-2"]);
        expect(state.uploads.map((u) => u.path)).toEqual([
          "/api/assistant-conversations/dinner/attachments",
          "/api/assistant-conversations/dinner/attachments",
        ]);
        await expect(tray).toHaveCount(0);

        // After a reload the history shows the files with the owner's words.
        state.history = {
          ...state.history,
          messages: [
            ...state.history.messages,
            {
              id: "with-files",
              role: "user",
              text: "What can I cook with this?",
              attachments: [
                {
                  id: "file-1",
                  name: "photo.png",
                  type: "image/png",
                  kind: "image",
                  size: 70,
                },
                {
                  id: "file-2",
                  name: "notes.md",
                  type: "text/plain",
                  kind: "text",
                  size: 18,
                },
              ],
            },
          ],
        };
        await page.reload();
        const sent = page.getByRole("list", { name: w.sent });
        await expect(sent.locator("img")).toHaveAttribute(
          "src",
          "/api/assistant-attachments/file-1",
        );
        await expect(sent.locator("img")).toHaveJSProperty("naturalWidth", 160);
        await expect(
          sent.getByRole("link", { name: w.download("notes.md") }),
        ).toHaveAttribute("href", "/api/assistant-attachments/file-2");
        await expect(page.getByText("What can I cook with this?")).toBeVisible();
        if (shots && language === "en")
          await page.screenshot({
            path: path.join(shots, `lead-history-${viewport.name}.png`),
          });

        // A member chat has a "+" with only the attachment, and its own uploads.
        await page.goto(baseURL + "/agents/member-0/chats/member-chat");
        await page.getByRole("button", { name: w.options, exact: true }).click();
        await expect(page.getByRole("button", { name: w.attach })).toBeVisible();
        await expect(page.getByRole("switch", { name: w.team })).toHaveCount(0);
        if (shots && language === "en")
          await page.screenshot({
            path: path.join(shots, `member-options-${viewport.name}.png`),
          });
        await page.keyboard.press("Escape");
        await pick(page, w, [files.notes]);
        await expect(
          page.getByRole("list", { name: w.list }).getByText("notes.md"),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: w.send })).toBeEnabled();
        if (shots && language === "en")
          await page.screenshot({
            path: path.join(shots, `member-composer-${viewport.name}.png`),
          });
        // Files alone are a message.
        await page.getByRole("button", { name: w.send }).click();
        await expect.poll(() => state.posted.length).toBe(2);
        expect(state.posted[1].text).toBe("");
        expect(state.posted[1].attachments).toEqual(["file-3"]);
        expect(state.uploads.at(-1).path).toBe(
          "/api/assistant-conversations/member-chat/attachments",
        );
      } finally {
        t.cleanup();
      }
    });

for (const language of ["en", "de"])
  for (const viewport of viewports)
    test(`${language} ${viewport.name}: oversized, unsupported and image-blind cases explain themselves`, async ({
      page,
    }) => {
      const w = words[language];
      const t = {};
      const files = tempFiles(t);
      try {
        await page.setViewportSize(viewport);
        const state = await chatFixture(page, { language });
        await attachmentRoutes(page, state, { imageInput: false });
        await page.goto(baseURL + "/agents/home/chats/dinner");
        await pick(page, w, [files.huge]);
        await expect(page.getByRole("alert")).toHaveText(w.tooLarge);
        await pick(page, w, [files.tool]);
        await expect(page.getByRole("alert")).toHaveText(w.unsupported);
        expect(state.uploads).toEqual([]);
        // A model without image input is named before sending; the file still uploads.
        await pick(page, w, [files.photo]);
        await expect(
          page.getByRole("status").filter({ hasText: w.noImages }),
        ).toBeVisible();
        if (shots && language === "en")
          await page.screenshot({
            path: path.join(shots, `errors-${viewport.name}.png`),
          });
        // Pasting a file attaches it as well.
        await page.locator("#assistant-message").focus();
        await page.evaluate(() => {
          const data = new DataTransfer();
          data.items.add(new File(["pasted"], "pasted.txt", { type: "text/plain" }));
          const paste = new Event("paste", { bubbles: true, cancelable: true });
          Object.defineProperty(paste, "clipboardData", { value: data });
          document.querySelector("#assistant-message").dispatchEvent(paste);
        });
        await expect(
          page.getByRole("list", { name: w.list }).getByText("pasted.txt"),
        ).toBeVisible();
        await expect
          .poll(() => state.uploads.map((u) => u.name))
          .toEqual(["photo.png", "pasted.txt"]);
      } finally {
        t.cleanup();
      }
    });

// The whole chat panel is the drop zone, like the session chat.
const dropShots = process.env.AGENTPIER_DROP_SHOTS;
const fileTransfer = (page, name = "dropped.png", type = "image/png") =>
  page.evaluateHandle(
    ([bytes, fileName, fileType]) => {
      const carrier = new DataTransfer();
      carrier.items.add(new File([new Uint8Array(bytes)], fileName, { type: fileType }));
      return carrier;
    },
    [[...png], name, type],
  );

async function openDropChat(page) {
  const state = await chatFixture(page, { language: "en" });
  await attachmentRoutes(page, state);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator("#assistant-message")).toBeVisible();
  return state;
}

test("dropping a file on the agent chat panel shows the hint and attaches it", async ({
  page,
}) => {
  const state = await openDropChat(page);
  const panel = page.locator(".assistant-chat-panel");
  const dataTransfer = await fileTransfer(page);
  await panel.dispatchEvent("dragover", { dataTransfer });
  await expect(panel).toHaveAttribute("data-dropping", "true");
  await expect(panel).toHaveAttribute("data-drop-hint", "Drop files here");
  if (dropShots) await page.screenshot({ path: path.join(dropShots, "agent-drop.png") });
  await panel.dispatchEvent("drop", { dataTransfer });
  await expect(
    page.getByRole("list", { name: "Attachments" }).getByText("dropped.png"),
  ).toBeVisible();
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
  await expect.poll(() => state.uploads.map((u) => u.name)).toEqual(["dropped.png"]);
});

test("dragged text does not arm the agent chat drop zone", async ({ page }) => {
  const state = await openDropChat(page);
  const panel = page.locator(".assistant-chat-panel");
  const dataTransfer = await page.evaluateHandle(() => {
    const carrier = new DataTransfer();
    carrier.setData("text/plain", "some selected text");
    return carrier;
  });
  await panel.dispatchEvent("dragover", { dataTransfer });
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
  await panel.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.uploads).toEqual([]);
});

test("a dropped unsupported file explains itself and uploads nothing", async ({
  page,
}) => {
  const state = await openDropChat(page);
  const panel = page.locator(".assistant-chat-panel");
  await panel.dispatchEvent("drop", {
    dataTransfer: await fileTransfer(page, "tool.exe", "application/octet-stream"),
  });
  await expect(page.getByRole("alert")).toHaveText(words.en.unsupported);
  expect(state.uploads).toEqual([]);
});

test("a cancelled drag clears the agent chat overlay without uploading", async ({
  page,
}) => {
  const state = await openDropChat(page);
  const panel = page.locator(".assistant-chat-panel");
  await panel.dispatchEvent("dragover", { dataTransfer: await fileTransfer(page) });
  await expect(panel).toHaveAttribute("data-dropping", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
  expect(state.uploads).toEqual([]);
});

test("touch-only devices do not arm the agent chat drop zone", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    storageState: `.cache/browser-auth-${new URL(baseURL).port}.json`,
  });
  const page = await context.newPage();
  try {
    const state = await openDropChat(page);
    const panel = page.locator(".assistant-chat-panel");
    const dataTransfer = await fileTransfer(page);
    await panel.dispatchEvent("dragover", { dataTransfer });
    await expect(panel).not.toHaveAttribute("data-dropping", "true");
    await panel.dispatchEvent("drop", { dataTransfer });
    await page.waitForTimeout(150);
    expect(state.uploads).toEqual([]);
  } finally {
    await context.close();
  }
});
