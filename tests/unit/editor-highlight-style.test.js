import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tags } from "@lezer/highlight";
import {
  editorHighlightStyle,
  syntaxTokens,
} from "../../web/components/editor-highlight.js";

const web = new URL("../../web/", import.meta.url);
const css = await readFile(new URL("styles/base.css", web), "utf8");
const declared = new Map(
  [...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
    name,
    value.trim(),
  ]),
);
const resolve = (value, depth = 0) =>
  depth > 5
    ? value
    : value.replace(/var\((--[\w-]+)\)/g, (match, name) =>
        declared.has(name) ? resolve(declared.get(name), depth + 1) : match,
      );
function luminance(hex) {
  const digits = hex.replace("#", "");
  const full =
    digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("every syntax colour meets WCAG AA against the editor background", () => {
  const background = resolve("var(--syntax-bg)");
  assert.match(background, /^#[0-9a-f]{3,8}$/i);
  assert.ok(syntaxTokens.length >= 8);
  for (const token of syntaxTokens) {
    const value = resolve(`var(${token})`);
    assert.match(value, /^#[0-9a-f]{3,6}$/i, `${token} resolves to a colour`);
    const ratio = contrast(value, background);
    assert.ok(ratio >= 4.5, `${token} ${value} has ${ratio.toFixed(2)}:1`);
  }
});

test("the highlight style colours code only through theme tokens", () => {
  const specs = editorHighlightStyle.specs;
  for (const spec of specs)
    if (spec.color) assert.match(spec.color, /^var\(--syntax-[\w-]+\)$/);
  const used = new Set(specs.map((spec) => spec.color).filter(Boolean));
  for (const token of syntaxTokens.filter((name) => name !== "--syntax-text"))
    assert.ok(used.has(`var(${token})`), `${token} is used`);
});

test("the highlight style styles the common code tags", () => {
  for (const tag of [
    tags.keyword,
    tags.string,
    tags.number,
    tags.comment,
    tags.propertyName,
    tags.typeName,
    tags.tagName,
    tags.heading,
    tags.invalid,
  ])
    assert.ok(editorHighlightStyle.style([tag]), `styles ${tag}`);
});

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await sources(url)));
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(url);
  }
  return out;
}

test("no editor uses CodeMirror's light default highlight style", async () => {
  for (const file of await sources(web))
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /defaultHighlightStyle/,
      file.pathname,
    );
});
