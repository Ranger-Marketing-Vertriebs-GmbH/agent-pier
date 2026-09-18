import { parse, walk, generate } from "css-tree";
import { parse as parseModules } from "es-module-lexer/js";
export function unsupported() {
  return Object.assign(new Error("ARTIFACT_RESOURCE_UNSUPPORTED"), {
    code: "ARTIFACT_RESOURCE_UNSUPPORTED",
  });
}
export function dataUrl(mediaType, text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mediaType};base64,${btoa(binary)}`;
}
export function artifactBundle(snapshot, { maxDocumentBytes = 96 * 1024 * 1024 } = {}) {
  let remaining = maxDocumentBytes;
  const charge = (length) => {
    remaining -= length;
    if (remaining < 0) throw unsupported();
  };
  const encoded = (type, text) => {
    charge(text.length * 4);
    return dataUrl(type, text);
  };
  if (!Array.isArray(snapshot.files) || snapshot.files.length > 500) throw unsupported();
  const files = new Map();
  let bytes = 0;
  for (const file of snapshot.files) {
    if (
      !/^[\w./ -]+$/.test(file.path) ||
      file.path.startsWith("/") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      files.has(file.path)
    )
      throw unsupported();
    const raw = atob(file.base64);
    bytes += raw.length;
    if (bytes > 50 * 1024 * 1024) throw unsupported();
    files.set(file.path, {
      ...file,
      text: new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))),
    });
  }
  const resolve = (reference, from) => {
    if (!reference || /^[a-z][a-z\d+.-]*:|^\/|^\\/i.test(reference)) throw unsupported();
    let decoded;
    try {
      decoded = decodeURIComponent(reference.split(/[?#]/)[0]);
    } catch {
      throw unsupported();
    }
    if (decoded.includes("\\") || decoded.startsWith("/")) throw unsupported();
    const parts = from.split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (part === "..") {
        if (!parts.length) throw unsupported();
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    const name = parts.join("/");
    if (!files.has(name)) throw unsupported();
    return name;
  };
  const rawUrl = (name) => {
    const file = files.get(name);
    if (
      !file ||
      !/^(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|font\/(?:woff2?|ttf|otf)|text\/(?:javascript|css)|application\/(?:javascript|json))$/.test(
        file.mediaType,
      )
    )
      throw unsupported();
    return `data:${file.mediaType};base64,${file.base64}`;
  };
  const styles = new Map();
  function css(text, from, ancestors = new Set(), context = "stylesheet") {
    charge(text.length);
    const tree = parse(text, { context });
    walk(tree, (node) => {
      if (node.type === "Url") {
        if (!node.value.startsWith("data:") && !node.value.startsWith("#"))
          node.value = asset(node.value, from, ancestors);
        charge(node.value.length * 2);
      }
      if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
        const first = node.prelude?.children.first;
        if (first?.type === "String") {
          first.value = asset(first.value, from, ancestors);
          charge(first.value.length * 2);
        }
      }
    });
    return generate(tree);
  }
  function asset(reference, from, ancestors = new Set()) {
    if (/^data:(?:image|font)\//i.test(reference) || reference.startsWith("#"))
      return reference;
    const name = resolve(reference, from);
    if (files.get(name).mediaType !== "text/css") return rawUrl(name);
    if (ancestors.has(name)) throw unsupported();
    if (!styles.has(name))
      styles.set(
        name,
        encoded(
          "text/css",
          css(files.get(name).text, name, new Set([...ancestors, name])),
        ),
      );
    return styles.get(name);
  }
  const modules = new Map(),
    imports = {};
  async function moduleSource(source, from) {
    const [references] = parseModules(source);
    let result = source;
    const replacements = [];
    for (const entry of references) {
      if (entry.type === "import.meta") throw unsupported(); // import.meta has no filesystem URL here
      if (!entry.specifier) throw unsupported();
      const name = resolve(entry.specifier, from);
      const id = await moduleFile(name);
      replacements.push({
        ...entry,
        value: entry.type === "dynamic" ? JSON.stringify(id) : id,
      });
    }
    for (const entry of replacements.reverse())
      result = result.slice(0, entry.start) + entry.value + result.slice(entry.end);
    return result;
  }
  async function moduleFile(name) {
    if (modules.has(name)) return modules.get(name);
    const file = files.get(name);
    if (!file || !/^(text|application)\/javascript$/.test(file.mediaType))
      throw unsupported();
    const id = `artifact-module-${modules.size}`;
    modules.set(name, id);
    imports[id] = encoded("text/javascript", await moduleSource(file.text, name));
    return id;
  }
  return {
    files,
    resolve,
    asset,
    css,
    moduleFile,
    moduleSource,
    imports,
    charge,
    encoded,
  };
}
