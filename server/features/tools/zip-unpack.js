import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { problem } from "../../lib/storage.js";
import {
  assertLinksInside,
  checkLink,
  entryMode,
  entryName,
  realParents,
} from "./archive-safety.js";

const MAX_LINK = 4096;
const bad = (message) => problem(message, 409);
const defaults = () => ({
  maxExpanded: 2 * 1024 * 1024 * 1024,
  maxFiles: 30000,
  invalid: serverMessages.tools.archiveInvalid,
});

/**
 * Unpacks the zip archive `file` into `dest`, keeping modes and relative links. Every
 * entry lies below `top`; `limits.invalid` is the message for a damaged archive.
 */
export async function unpackZip(file, dest, top, signal, limits = {}) {
  const { maxExpanded, maxFiles, invalid } = { ...defaults(), ...limits };
  // Loaded on use: the installer scripts import this module before dependencies exist.
  const { open: openZip } = await import("yauzl");
  return new Promise((resolve, reject) => {
    openZip(
      file,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(bad(invalid));
        let failed = false,
          count = 0,
          expanded = 0;
        const seen = new Set(),
          links = [];
        const fail = (cause) => {
          if (failed) return;
          failed = true;
          zip.close();
          // A full disk is passed through so the caller can name it.
          if (["ENOSPC", "EDQUOT"].includes(cause?.code)) reject(cause);
          else reject(cause?.status ? cause : bad(invalid));
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (failed) return;
          try {
            assertLinksInside(dest, top, links);
            resolve();
          } catch (cause) {
            reject(cause);
          }
        });
        const read = (entry) =>
          new Promise((done, stop) =>
            zip.openReadStream(entry, (err, stream) => (err ? stop(err) : done(stream))),
          );
        zip.on("entry", async (entry) => {
          try {
            if (signal?.aborted)
              throw bad(serverMessages.tools.installationAbortedOrTimedOut);
            const relative = entryName(entry.fileName, top);
            const mode = (entry.externalFileAttributes >>> 16) & 0o177777;
            const kind = mode & 0o170000;
            const directory = entry.fileName.endsWith("/") || kind === 0o040000;
            if (entry.generalPurposeBitFlag & 1)
              throw bad(serverMessages.tools.encryptedArchivesForbidden);
            if (++count > maxFiles || (expanded += entry.uncompressedSize) > maxExpanded)
              throw bad(serverMessages.tools.archiveSizeExceeded);
            const key = relative.toLowerCase();
            if (seen.has(key)) throw bad(serverMessages.tools.duplicateArchivePaths);
            seen.add(key);
            const target = path.join(dest, relative);
            await realParents(dest, directory ? `${relative}/x` : relative);
            if (directory) {
              const stat = await fsp.lstat(target).catch(() => null);
              if (!stat) await fsp.mkdir(target, { mode: 0o755 });
              else if (!stat.isDirectory())
                throw bad(serverMessages.tools.unsafeArchivePath);
            } else if (kind === 0o120000) {
              if (entry.uncompressedSize > MAX_LINK)
                throw bad(serverMessages.tools.unsafeArchivePath);
              const chunks = [];
              for await (const chunk of await read(entry)) chunks.push(chunk);
              const link = Buffer.concat(chunks).toString("utf8");
              checkLink(relative, link, top);
              await fsp.symlink(link, target);
              links.push(target);
            } else if (kind === 0o100000 || kind === 0) {
              await pipeline(
                await read(entry),
                fs.createWriteStream(target, { flags: "wx", mode: entryMode(mode) }),
                { signal },
              );
            } else throw bad(serverMessages.tools.specialArchiveFilesForbidden);
            zip.readEntry();
          } catch (cause) {
            fail(cause);
          }
        });
        zip.readEntry();
      },
    );
  });
}
