import { createHash } from "node:crypto";
import { parse } from "parse5";
import { startApp } from "../web/startup/loader.js";
import { startupCopy as de } from "../web/lib/i18n/de/startup.js";
import { startupCopy as en } from "../web/lib/i18n/en/startup.js";

export function startupPlugin() {
  return {
    name: "agentpier-startup",
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/__STARTUP_(\w+)__/g, (_match, key) => de[key]);
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const html = bundle["index.html"];
        if (!html) throw new Error("Missing app document");
        let source = String(html.source);
        const entries = [],
          assets = new Map(),
          removals = [];
        function visit(node) {
          const attrs = Object.fromEntries(
            (node.attrs || []).map(({ name, value }) => [name, value]),
          );
          if (node.tagName === "script" && attrs.type === "module" && attrs.src) {
            entries.push(attrs.src);
            assets.set(attrs.src, { url: attrs.src, kind: "module" });
            removals.push(node.sourceCodeLocation);
          }
          if (
            node.tagName === "link" &&
            ["stylesheet", "modulepreload"].includes(attrs.rel)
          ) {
            assets.set(attrs.href, {
              url: attrs.href,
              kind: attrs.rel === "stylesheet" ? "style" : "module",
            });
            removals.push(node.sourceCodeLocation);
          }
          for (const child of node.childNodes || []) visit(child);
        }
        visit(parse(source, { sourceCodeLocationInfo: true }));
        if (!entries.length) throw new Error("Missing app entry");
        for (const { startOffset, endOffset } of removals.sort(
          (a, b) => b.startOffset - a.startOffset,
        ))
          source = source.slice(0, startOffset) + source.slice(endOffset);
        const script = `(${startApp.toString()})(${JSON.stringify({ entries, assets: [...assets.values()], catalogs: { de, en } })});`;
        const hash = createHash("sha256").update(script).digest("hex").slice(0, 12);
        const fileName = `assets/startup-${hash}.js`;
        this.emitFile({ type: "asset", fileName, source: script });
        html.source = source.replace(
          "</body>",
          `<script defer src="/${fileName}"></script></body>`,
        );
      },
    },
  };
}
