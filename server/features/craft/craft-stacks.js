// The `build_with` values Craft Anything 0.6.0 accepts: the stack names its
// rebuild_start resolves (stacks.toml; 0.6.0 added Phaser and Bevy). Pinned beside
// craftManifest: updating Craft Anything means checking this list too.
export const defaultCraftStack = "Builder's choice";

export const craftStacks = Object.freeze([
  defaultCraftStack,
  "Plain HTML and CSS",
  "React + TypeScript (Vite)",
  "Next.js + TypeScript",
  "Python",
  "Electron",
  "Rust (console)",
  "Rust + macroquad",
  "Rust + egui (eframe)",
  "Phaser",
  "Bevy",
  "unity",
  "unreal",
  "godot",
]);
