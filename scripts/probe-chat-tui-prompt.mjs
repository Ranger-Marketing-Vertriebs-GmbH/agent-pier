import { syntheticPng } from "./probe-chat-tui-images.mjs";
import fs from "node:fs/promises";
import path from "node:path";
// Native prompt regression probe; only runs in the disposable local-mock fixture.
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { waitFor } from "./probe-chat-tui-utils.mjs";
import { nativePromptState } from "../server/features/sessions/native-prompt.js";
import { randomUUID } from "node:crypto";
export async function probePromptSpike({
  manager,
  session,
  snapshot,
  keys,
  fixture,
  provider,
}) {
  const frames = {};
  const target = `${manager.target(session.id)}:0.0`;
  const paste = async (text) => {
    const buffer = randomUUID();
    await manager.tmux(["load-buffer", "-b", buffer, "-"], { input: text });
    await manager.tmux(["paste-buffer", "-d", "-p", "-r", "-b", buffer, "-t", target]);
    await sleep(350);
  };
  const record = async (name) => {
    await sleep(200);
    frames[name] = await snapshot();
  };
  await record("idle");
  for (const [name, text] of [
    ["short", "AP_PROBE_DRAFT"],
    ["multiline", "first\nsecond\nthird"],
    ["blank-indent", "first\n\n  indented"],
    ["long", "AP_PROBE_LONG_" + "x".repeat(300)],
  ]) {
    await paste(text);
    await record(name);
    for (let i = 0; i < 4; i++) {
      await keys("C-e", "C-u");
      await record(`${name}-clear-${i}`);
      await keys("BSpace");
    }
    await record(`${name}-cleared`);
  }
  await paste("/model");
  await record("slash");
  await keys("Enter");
  await record("model");
  await keys("Escape");
  await record("model-closed");
  if (session.tool === "opencode") {
    await keys("C-p");
    await record("commands");
    await keys("Escape");
  }
  const scope = JSON.stringify([
    session.id,
    session.accountId,
    session.tool,
    session.createdAt,
  ]);
  const results = [];
  const imagePath = path.join(session.cwd, "synthetic image.png");
  await fs.writeFile(imagePath, syntheticPng());
  for (const imagesFirst of [false, true]) {
    const marker = imagesFirst ? "AP_PROBE_IMAGE_FIRST" : "AP_PROBE_IMAGE_LAST";
    // Characterize the CLI's original single-paste behavior without the adapter.
    await paste((imagesFirst ? [imagePath, marker] : [marker, imagePath]).join("\n"));
    await keys("Enter");
    await waitFor(
      () => provider.events,
      (events) => events.some((e) => e.marker === marker && e.kind === "complete"),
    );
    results.push({
      imagesFirst,
      imageCount: provider.events.find((e) => e.marker === marker && e.kind === "request")
        .imageCount,
    });
    await sleep(300);
  }

  await paste(session.tool === "codex" ? JSON.stringify(imagePath) : imagePath);
  frames.imageOnlyPaste = await snapshot();
  await paste(" AP_PROBE_IMAGE_SPLIT");
  await keys("Enter");
  await waitFor(
    () => provider.events,
    (events) =>
      events.some((e) => e.marker === "AP_PROBE_IMAGE_SPLIT" && e.kind === "complete"),
  );
  results.push({
    splitImagePaste: true,
    imageCount: provider.events.find(
      (e) => e.marker === "AP_PROBE_IMAGE_SPLIT" && e.kind === "request",
    ).imageCount,
  });
  await sleep(300);
  for (const [width, height] of [
    [120, 35],
    [50, 34],
    [36, 12],
  ]) {
    await manager.tmux([
      "resize-window",
      "-t",
      target,
      "-x",
      String(width),
      "-y",
      String(height),
    ]);
    await paste(session.tool === "opencode" ? "/models" : "/model");
    await keys("Enter");
    await sleep(400);
    const menu = await snapshot();
    frames[`menu-${width}`] = menu;
    assert.equal(nativePromptState(session.tool, menu).state, "dialog", `menu ${width}`);
    const text = `AP_PROBE_MENU_${width}`;
    const body = { deliveryId: randomUUID(), deliveryScope: scope, text, submit: true };
    const endpoint = `/api/sessions/${session.id}/input`;
    const send = async () =>
      (await fixture.request(endpoint, { method: "POST", body })).json();
    const held = await send();
    assert.equal(held.status, "pending", JSON.stringify(held));
    assert.equal(held.waiting, "dialog");
    assert.equal((await send()).status, "pending");
    assert.equal(
      provider.events.some((e) => e.marker === text),
      false,
    );
    await keys("Escape");
    await waitFor(
      async () =>
        (
          await fixture.request(
            `${endpoint}/${body.deliveryId}?scope=${encodeURIComponent(scope)}`,
          )
        ).json(),
      (r) => r.status === "handed-off",
    );
    await waitFor(
      () => provider.events,
      (e) => e.some((v) => v.marker === text && v.kind === "complete"),
    );
    assert.equal(
      provider.events.filter((e) => e.marker === text && e.kind === "request").length,
      1,
    );
    results.push({ width, height, held: true, deliveredOnce: true });
    await sleep(300);
  }
  await manager.tmux(["resize-window", "-t", target, "-x", "120", "-y", "35"]);
  await paste("AP_PROBE_PERMISSION");
  await keys("Enter");
  await waitFor(
    async () => {
      const f = await snapshot();
      frames.permission = f;
      return f.raw;
    },
    (raw) =>
      /permission|Would you like|Allow once/i.test(raw) &&
      /printf AP_PROBE_PERMISSION/.test(raw),
  ).catch((error) => {
    console.error("PERMISSION_SCREEN", frames.permission);
    throw error;
  });
  await sleep(500);
  frames.permission = await snapshot();
  const held = [];
  for (const [width, height] of [
    [120, 35],
    [50, 34],
    [36, 12],
  ]) {
    await manager.tmux([
      "resize-window",
      "-t",
      target,
      "-x",
      String(width),
      "-y",
      String(height),
    ]);
    await sleep(300);
    const frame = await snapshot();
    frames[`permission-${width}`] = frame;
    if (nativePromptState(session.tool, frame).state !== "dialog")
      console.error("UNRECOGNIZED_PERMISSION", JSON.stringify(frame));
    assert.equal(
      nativePromptState(session.tool, frame).state,
      "dialog",
      `permission ${width}`,
    );
    const body = {
      deliveryId: randomUUID(),
      deliveryScope: scope,
      text: `AP_PROBE_AFTER_PERMISSION_${width}`,
      submit: true,
    };
    const receipt = await (
      await fixture.request(`/api/sessions/${session.id}/input`, { method: "POST", body })
    ).json();
    assert.equal(receipt.status, "pending", JSON.stringify(receipt));
    assert.equal(nativePromptState(session.tool, await snapshot()).state, "dialog");
    held.push(body);
  }
  // Explicit simulated user rejection, never performed by the delivery guard.
  if (session.tool === "codex") await keys("Escape");
  else await keys("Right", "Right", "Enter");
  for (const body of held) {
    await waitFor(
      () => provider.events,
      (events) => events.some((e) => e.marker === body.text && e.kind === "complete"),
    );
    assert.equal(
      provider.events.filter((e) => e.marker === body.text && e.kind === "request")
        .length,
      1,
    );
  }
  results.push({ permissionsHeld: held.length, deliveredOnceAfterUserAnswer: true });
  await manager.tmux(["resize-window", "-t", target, "-x", "120", "-y", "35"]);
  return { frames, results };
}
