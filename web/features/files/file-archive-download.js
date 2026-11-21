import { appleStandalone, saveUrl } from "../../lib/standalone.js";
import { isTerminal } from "./file-action-utils.js";

// Hands a finished ZIP to the browser: a link with `download` saves it under the
// server's file name; an iPhone home-screen app gets the share sheet instead.
export function saveArchive(href) {
  if (appleStandalone()) return saveUrl(href).catch(() => {});
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.append(link);
  link.click();
  // Removed after the browser took the click: an immediate removal can cancel it.
  setTimeout(() => link.remove(), 1000);
}

/**
 * "Download as ZIP" starts an archive job; once it completes with its artifact, the
 * download starts by itself. A failed or cancelled job saves nothing (Activity shows
 * why). Returns a function that stops following.
 */
export function followArchiveDownload(jobs, id, save = saveArchive) {
  let done = false;
  let stop = () => {};
  const check = () => {
    if (done) return;
    const job = jobs.getSnapshot().jobs.find((item) => item.id === id);
    if (!job || !isTerminal(job)) return;
    done = true;
    stop();
    if (job.status === "completed" && job.artifactReady === true)
      save(jobs.archiveHref(id));
  };
  stop = jobs.subscribe(check);
  check();
  return () => {
    done = true;
    stop();
  };
}
