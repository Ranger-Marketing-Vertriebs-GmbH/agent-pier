import { StreamLanguage } from "@codemirror/language";

export async function loadLanguage(path) {
  const extension = path.split(".").at(-1).toLowerCase();
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(extension))
    return (await import("@codemirror/lang-javascript")).javascript({
      jsx: ["jsx", "tsx"].includes(extension),
      typescript: ["ts", "tsx"].includes(extension),
    });
  if (extension === "json") return (await import("@codemirror/lang-json")).json();
  if (["html", "htm"].includes(extension))
    return (await import("@codemirror/lang-html")).html();
  if (extension === "css") return (await import("@codemirror/lang-css")).css();
  if (["md", "markdown"].includes(extension))
    return (await import("@codemirror/lang-markdown")).markdown();
  if (extension === "py") return (await import("@codemirror/lang-python")).python();
  if (["yml", "yaml"].includes(extension))
    return (await import("@codemirror/lang-yaml")).yaml();
  if (["sh", "bash", "zsh", "toml"].includes(extension)) {
    const [mode] = await Promise.all([
      extension === "toml"
        ? import("@codemirror/legacy-modes/mode/toml")
        : import("@codemirror/legacy-modes/mode/shell"),
    ]);
    return StreamLanguage.define(extension === "toml" ? mode.toml : mode.shell);
  }
  return [];
}
