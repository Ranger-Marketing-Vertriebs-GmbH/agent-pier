import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const web = new URL("../../web/", import.meta.url);
async function cssFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await cssFiles(url)));
    else if (entry.name.endsWith(".css")) out.push(url);
  }
  return out;
}
test("assistant and shell styles only use defined custom properties", async () => {
  const files = await cssFiles(web);
  const defined = new Set();
  for (const file of files)
    for (const [, name] of (await readFile(file, "utf8")).matchAll(/(--[\w-]+)\s*:/g))
      defined.add(name);
  // Runtime-set properties (useSessionViewport) are not declared in CSS.
  for (const name of ["--session-viewport-height", "--session-viewport-top"])
    defined.add(name);
  const checked = files.filter((f) =>
    /features\/assistants\/|app\/layout\.css|app\/sidebar-menu\.css/.test(f.pathname),
  );
  for (const file of checked) {
    const css = await readFile(file, "utf8");
    for (const [, name] of css.matchAll(/var\((--[\w-]+)/g))
      assert.ok(defined.has(name), `${file.pathname}: ${name} is undefined`);
  }
});
test("redesign tokens exist with the handoff values", async () => {
  const css = await readFile(new URL("styles/base.css", web), "utf8");
  const expected = {
    "--text": "#e8e8ec",
    "--sidebar-bg": "#15161a",
    "--header-bg": "#16171b",
    "--header-line": "#28292d",
    "--popover-bg": "#1b1c20",
    "--popover-raised": "#1f2024",
    "--popover-shadow": "0 18px 40px -12px #000",
    "--scrim": "#0b0c0e99",
    "--accent-text": "#ffc99d",
    "--accent-focus": "#f49a5866",
    "--button-secondary-bg": "#202125",
    "--button-secondary-line": "#323337",
    "--button-secondary-text": "#dcdde1",
    "--nav-selected": "#26272b",
    "--pill-bg": "#1c1d21",
    "--pill-text": "#b9babe",
    "--text-row": "#cfd0d4",
    "--text-meta": "#8a8b8f",
    "--text-menu": "#c4c5c9",
    "--text-group": "#97989c",
    "--text-faint": "#6f7075",
    "--text-message": "#e1e2e6",
    "--placeholder": "#6b6c70",
    "--hint": "#7e7f83",
    "--approval-bg": "#1b1a19",
    "--approval-line": "#2e2924",
    "--divider": "#2a2b30",
    "--divider-soft": "#24252a",
    "--switch-off": "#3a3b3f",
    "--switch-knob": "#fff",
    "--on-accent": "#242529",
  };
  for (const [name, value] of Object.entries(expected))
    assert.match(css, new RegExp(`${name}:\\s*${value.replace(/[-#]/g, "\\$&")};`), name);
});
