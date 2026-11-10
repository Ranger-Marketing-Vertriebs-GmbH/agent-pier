// The `build_with` values Craft Anything 0.6.0 accepts (the stacks its rebuild_start
// resolves; 0.6.0 added Phaser and Bevy),
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
  "Phaser",
  "Bevy",
  "unity",
  "unreal",
  "godot",
]);
