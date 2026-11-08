// The `build_with` values Craft Anything 0.5.0 accepts (its rebuild_start schema),
// pinned beside craftManifest: updating Craft Anything means checking this list too.
export const defaultCraftStack = "Builder's choice";

export const craftStacks = Object.freeze([
  defaultCraftStack,
  "Plain HTML and CSS",
  "React + TypeScript (Vite)",
  "Next.js + TypeScript",
  "Python",
  "Electron",
  "Rust (console)",
  "Rust + egui (eframe)",
  "unity",
  "unreal",
  "godot",
]);
