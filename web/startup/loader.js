// Serialized into a tiny standalone build asset: keep this function self-contained.
export function startApp({ entries, assets, catalogs }) {
  const screen = document.getElementById("startup");
  if (!screen) return;
  let saved;
  try {
    saved = localStorage.getItem("agentpier-language");
  } catch {}
  const preferred = (navigator.languages || [navigator.language])
    .map((value) => String(value).toLowerCase().split("-")[0])
    .find((value) => value === "de" || value === "en");
  const language = saved === "de" || saved === "en" ? saved : preferred || "en";
  document.documentElement.lang = language;
  const copy = catalogs[language];
  const label = screen.querySelector("[data-startup-status]");
  const detail = screen.querySelector("[data-startup-detail]");
  const progress = screen.querySelector("progress");
  progress.setAttribute("aria-label", copy.downloading);
  const hint = screen.querySelector("[data-startup-hint]");
  const retry = screen.querySelector("a");
  screen.querySelector("h1").textContent = copy.title;
  retry.textContent = copy.retry;
  retry.href = location.href;
  retry.addEventListener("click", (event) => {
    event.preventDefault();
    location.reload();
  });
  let failed = false;
  let finished = false;
  let completed = 0;
  const measurable = document.createElement("link").relList?.supports?.("modulepreload");
  function stage(name) {
    label.textContent = copy[name];
    progress.hidden = true;
    detail.hidden = true;
  }
  function changed(event) {
    if (event.detail === "done") {
      finished = true;
      clearTimeout(slow);
      window.removeEventListener("agentpier-startup", changed);
      screen.remove();
    } else if (!failed && event.detail === "authenticating") stage("authenticating");
  }
  window.addEventListener("agentpier-startup", changed);
  const slow = setTimeout(() => {
    hint.textContent = copy.slow;
    hint.hidden = false;
  }, 15000);
  function update() {
    if (failed || finished || !measurable) return;
    const percent = Math.floor((completed / assets.length) * 100);
    progress.value = percent;
    detail.textContent = copy.progress
      .replace("{loaded}", completed)
      .replace("{total}", assets.length)
      .replace("{percent}", percent);
  }
  function load(asset) {
    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = asset.kind === "style" ? "stylesheet" : "modulepreload";
      // Keep loading CSS from blocking the bootstrap screen in WebKit.
      if (asset.kind === "style") link.media = "not all";
      link.crossOrigin = "anonymous";
      link.href = asset.url;
      link.onload = () => {
        if (asset.kind === "style") link.media = "all";
        completed++;
        update();
        resolve();
      };
      link.onerror = () => reject(new Error("Startup asset failed"));
      document.head.append(link);
    });
  }
  if (measurable) {
    label.textContent = copy.downloading;
    progress.hidden = false;
    detail.hidden = false;
    update();
  } else {
    // Older Safari can import modules, but never fires modulepreload events.
    // Vite's own fallback only runs after importing the entry.
    stage("starting");
  }
  // One native request per resource; modulepreload populates the module map used
  // by import(). Count completed files, not estimated bytes or elapsed time.
  Promise.all(assets.filter((asset) => measurable || asset.kind === "style").map(load))
    .then(async () => {
      if (finished || failed) return;
      stage("starting");
      for (const entry of entries) await import(/* @vite-ignore */ entry);
    })
    .catch(() => {
      if (finished) return;
      failed = true;
      clearTimeout(slow);
      hint.hidden = true;
      stage("failed");
      label.setAttribute("role", "alert");
    });
}
