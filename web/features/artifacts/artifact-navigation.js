import { unsupported } from "./artifact-bundle.js";

export const artifactNavigationType = "agentpier:artifact-link";

export function resolveArtifactLink(bundle, entrypoint, href) {
  if (typeof href !== "string" || !href || href.length > 4096) throw unsupported();
  const path = href.split(/[?#]/)[0] ? bundle.resolve(href, entrypoint) : entrypoint;
  if (
    !/^(?:text\/html|image\/(?:png|jpeg|gif|webp|avif|svg\+xml))$/.test(
      bundle.files.get(path)?.mediaType,
    )
  )
    throw unsupported();
  let fragment = "";
  try {
    if (href.includes("#"))
      fragment = decodeURIComponent(href.slice(href.indexOf("#") + 1));
  } catch {
    throw unsupported();
  }
  return { path, fragment };
}

// Runs inside the opaque sandbox. The parent independently validates every request.
function installNavigation(type, token, fragment) {
  function scrollToFragment(id) {
    if (!id) window.scrollTo(0, 0);
    else document.getElementById(id)?.scrollIntoView();
  }
  window.addEventListener(
    "load",
    () => {
      if (fragment) requestAnimationFrame(() => scrollToFragment(fragment));
    },
    { once: true },
  );
  function follow(event) {
    const link = event.target.closest?.("a[href], area[href]");
    if (!link || event.defaultPrevented) return;
    event.preventDefault();
    const href = link.getAttribute("href");
    if (href?.startsWith("#")) {
      try {
        scrollToFragment(decodeURIComponent(href.slice(1)));
      } catch {
        /* Invalid fragment stays on this page. */
      }
      return;
    }
    parent.postMessage({ type, token, href }, "*");
  }
  document.addEventListener("click", follow);
  document.addEventListener("auxclick", follow);
}

export function artifactNavigationScript(token, fragment = "") {
  return `(${installNavigation.toString()})(${JSON.stringify(artifactNavigationType)},${JSON.stringify(token)},${JSON.stringify(fragment)});`;
}
