export function startupStage(stage) {
  window.dispatchEvent(new CustomEvent("agentpier-startup", { detail: stage }));
  // The dev server uses Vite's regular entry instead of the production loader.
  if (stage === "done") {
    document.getElementById("startup")?.remove();
    document.getElementById("root")?.removeAttribute("inert");
    document.getElementById("root")?.removeAttribute("aria-hidden");
  }
}
