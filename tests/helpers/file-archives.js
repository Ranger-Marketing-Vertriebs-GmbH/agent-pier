import { Writable } from "node:stream";
import yauzl from "yauzl";
import { uploadRequest } from "./file-uploads.js";
export function zipEntries(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          stream.on("data", (bytes) => chunks.push(bytes));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
export const archiveOperation = (sources, extra = {}) => ({
  requestId: uploadRequest(),
  kind: "archive",
  sources,
  target: null,
  name: null,
  options: { output: "download" },
  ...extra,
});
export async function artifactBytes(f, id, scope = f.scope) {
  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  output.setHeader = () => {};
  await f.archives.downloadJobArtifact(scope, id, output);
  return Buffer.concat(chunks);
}
