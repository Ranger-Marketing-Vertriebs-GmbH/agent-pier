import { parse, parseFragment, serialize } from "parse5";
import { artifactBundle, dataUrl, unsupported } from "./artifact-bundle.js";
const policy =
  "default-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
export async function prepareArtifactDocument(snapshot) {
  const bundle = artifactBundle(snapshot);
  const entry = bundle.files.get(snapshot.entrypoint);
  if (!entry) throw unsupported();
  const document = parse(
    entry.mediaType === "text/html"
      ? entry.text
      : '<!doctype html><html><head></head><body><img alt=""></body></html>',
  );
  const html = document.childNodes.find((node) => node.tagName === "html");
  const head = html.childNodes.find((node) => node.tagName === "head");
  async function visit(parent) {
    for (const node of [...(parent.childNodes || [])]) {
      if (
        ["base", "iframe", "object", "embed"].includes(node.tagName) ||
        (node.tagName === "meta" && node.attrs.some((a) => a.name === "http-equiv"))
      ) {
        parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
        continue;
      }
      const attrs = node.attrs || [];
      const attr = (name) => attrs.find((a) => a.name === name);
      if (node.tagName === "script") {
        const type = attr("type")?.value || "";
        if (type === "importmap") throw unsupported();
        if (!["", "module", "text/javascript", "application/javascript"].includes(type))
          continue;
        let source = node.childNodes?.map((n) => n.value || "").join("") || "";
        const from = attr("src")
          ? bundle.resolve(attr("src").value, snapshot.entrypoint)
          : snapshot.entrypoint;
        if (attr("src")) {
          const file = bundle.files.get(from);
          if (!/^(text|application)\/javascript$/.test(file.mediaType))
            throw unsupported();
          source = file.text;
        }
        if (type === "module")
          source = attr("src")
            ? `import ${JSON.stringify(await bundle.moduleFile(from))};`
            : await bundle.moduleSource(source, from);
        node.attrs = attrs.filter(
          (a) => !["src", "integrity", "crossorigin"].includes(a.name),
        );
        node.attrs.push({ name: "src", value: dataUrl("text/javascript", source) });
        node.childNodes = [];
      } else {
        for (const item of attrs) {
          if (["src", "poster", "background"].includes(item.name))
            item.value = bundle.asset(item.value, snapshot.entrypoint);
          if (item.name === "href" && node.tagName === "link")
            item.value = bundle.asset(item.value, snapshot.entrypoint);
          if (item.name === "style")
            item.value = bundle.css(
              item.value,
              snapshot.entrypoint,
              new Set(),
              "declarationList",
            );
          if (item.name === "srcset") throw unsupported();
        }
        if (node.tagName === "style")
          node.childNodes = [
            {
              nodeName: "#text",
              value: bundle.css(
                node.childNodes.map((n) => n.value || "").join(""),
                snapshot.entrypoint,
              ),
              parentNode: node,
            },
          ];
        await visit(node);
        if (node.content) await visit(node.content);
      }
    }
  }
  await visit(document);
  if (entry.mediaType !== "text/html") {
    if (!entry.mediaType.startsWith("image/")) throw unsupported();
    const body = html.childNodes.find((node) => node.tagName === "body");
    body.childNodes[0].attrs.push({
      name: "src",
      value: bundle.asset(snapshot.entrypoint, "index.html"),
    });
  }
  const prefix = parseFragment(
    `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"><script type="importmap">${JSON.stringify({ imports: bundle.imports }).replaceAll("<", "\\u003c")}</script>`,
  );
  for (const child of prefix.childNodes) child.parentNode = head;
  head.childNodes.unshift(...prefix.childNodes);
  return { html: serialize(document), dispose() {} };
}
