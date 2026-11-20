// A refused edge drop in a split view says why on the pane (AGENTPIER-417), instead of
// ignoring the drop without a word.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { dragOver, dropOn, paneTransfer } from "../helpers/pane-drag.js";
import {
  layoutWrites,
  leaf,
  paneOf,
  sessions,
  split,
  splitViewFixture,
  viewId,
} from "../helpers/split-views-browser.js";

const S1 = "session:s1";
const s3 = {
  id: "s3",
  name: "Docs site",
  tool: "claude",
  cwd: "/fixture/s3",
  status: "running",
};
const overlay = (page, key) => paneOf(page, key).locator(".drop-zone-overlay");

test("an edge drop that leaves too little room says so instead of nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  const controls = await splitViewFixture(page, {
    layout: split("col", leaf.s1(), leaf.s2()),
  });
  controls.sessions = [sessions.s1, sessions.s2, s3];
  await page.goto(`${baseURL}/views/${viewId}`);
  await expect(page.locator(".split-pane")).toHaveCount(2);
  const third = await paneTransfer(page, { item: { kind: "session", id: "s3" } });
  await dragOver(paneOf(page, S1), "bottom", third);
  await expect(overlay(page, S1)).toHaveText("Too little room here for another pane.");
  await expect(overlay(page, S1)).toHaveAttribute("role", "status");
  await dropOn(paneOf(page, S1), "bottom", third);
  expect(layoutWrites(controls)).toEqual([]);
});
