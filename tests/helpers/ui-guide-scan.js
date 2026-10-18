import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { allowedMediaWidths } from "../../web/lib/breakpoints.js";

// Scanners behind tests/unit/ui-guide-rules.test.js (docs/ui-guide.md#enforcement).
// Each rule returns { "web/…": count } for the files that break it.

export const root = path.resolve(import.meta.dirname, "../..");
// Root font size (web/styles/base.css), for rem values.
const rootFontSize = 14;
export const fontSizeFloor = 11;

async function walk(directory, out = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file, out);
    else out.push(file);
  }
  return out;
}

/** Every web source file as { file: "web/…", text } with CSS comments removed. */
export async function webSources() {
  const files = (await walk(path.join(root, "web"))).filter((file) =>
    /\.(?:css|jsx?)$/.test(file),
  );
  return Promise.all(
    files.sort().map(async (file) => {
      const text = await readFile(file, "utf8");
      return {
        file: path.relative(root, file).split(path.sep).join("/"),
        text: file.endsWith(".css") ? text.replace(/\/\*[\s\S]*?\*\//g, "") : text,
      };
    }),
  );
}

const css = (sources) => sources.filter(({ file }) => file.endsWith(".css"));
const scripts = (sources) => sources.filter(({ file }) => !file.endsWith(".css"));

function tally(sources, count) {
  const found = {};
  for (const source of sources) {
    const n = count(source.text, source.file);
    if (n > 0) found[source.file] = n;
  }
  return found;
}

const hexColour = /#[0-9a-fA-F]{3,8}\b/g;

/** Hex colour literals outside the palette in web/styles/base.css. */
export const hexColours = (sources) =>
  tally(
    css(sources).filter(({ file }) => file !== "web/styles/base.css"),
    (text) => text.match(hexColour)?.length ?? 0,
  );

function pixels(value) {
  const match = /^(\d*\.?\d+)(px|rem)\b/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * (match[2] === "rem" ? rootFontSize : 1);
}

/** `font-size` declarations below the 11px floor (px and rem; em is relative). */
export const smallFontSizes = (sources) =>
  tally(css(sources), (text) => {
    let n = 0;
    for (const [, value] of text.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
      const size = pixels(value);
      if (size !== null && size > 0 && size < fontSizeFloor) n++;
    }
    return n;
  });

const widths = (query) =>
  [...query.matchAll(/(?:min|max)-width\s*:\s*(\d*\.?\d+(?:px|rem|em))/g)].map(
    (match) => match[1],
  );
const offWidths = (query) =>
  widths(query).filter((width) => !allowedMediaWidths.includes(width)).length;

/** Media query widths other than the breakpoints, in CSS and in JS query strings. */
export const mediaWidths = (sources) => ({
  ...tally(css(sources), (text) =>
    [...text.matchAll(/@media([^{]*)\{/g)].reduce(
      (n, [, query]) => n + offWidths(query),
      0,
    ),
  ),
  ...tally(
    scripts(sources).filter(({ file }) => file !== "web/lib/breakpoints.js"),
    (text) =>
      [...text.matchAll(/["'`]([^"'`\n]*\((?:min|max)-width[^"'`\n]*)["'`]/g)].reduce(
        (n, [, query]) => n + offWidths(query),
        0,
      ),
  ),
});

/** Focus outlines that do not use var(--focus-ring) (`none` and `0` are fine). */
export const focusOutlines = (sources) =>
  tally(css(sources), (text) => {
    let n = 0;
    for (const [, selector, body] of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (!selector.includes(":focus")) continue;
      for (const [, value] of body.matchAll(/(?:^|[;\s])outline\s*:\s*([^;]+)/g))
        if (!/^(?:none|0)\b/.test(value.trim()) && !value.includes("var(--focus-ring)"))
          n++;
    }
    return n;
  });

/** Browser dialogs (window.confirm, alert, prompt) instead of the app's dialogs. */
export const nativeDialogs = (sources) =>
  tally(
    scripts(sources),
    (text) =>
      text.match(/\b(?:window|globalThis|self)\.(?:confirm|alert|prompt)\s*\(/g)
        ?.length ?? 0,
  );

/** A custom property glued to an alpha suffix, such as `var(--accent)33`. */
export const alphaSuffixes = (sources) =>
  tally(css(sources), (text) => text.match(/var\(--[\w-]+\)\d/g)?.length ?? 0);

export const rules = {
  hexColours,
  smallFontSizes,
  mediaWidths,
  focusOutlines,
  nativeDialogs,
};

/**
 * Problems of `found` against an allowlist that may only shrink: a file above its
 * allowance (or new) fails, and so does a file below it, until the list is lowered.
 */
export function ratchet(found, allowed = {}) {
  const problems = [];
  for (const [file, count] of Object.entries(found)) {
    const limit = allowed[file] ?? 0;
    if (count > limit) problems.push(`${file}: ${count} (allowed ${limit})`);
  }
  for (const [file, limit] of Object.entries(allowed)) {
    const count = found[file] ?? 0;
    if (count < limit)
      problems.push(
        `${file}: ${count} left, lower its allowance from ${limit}` +
          (count ? ` to ${count}` : " by removing it"),
      );
  }
  return problems;
}
