import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

// Runs VACUUM INTO for sqliteSnapshotFileAsync (snapshot.js) off the main thread.
const db = new DatabaseSync(workerData.file, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout=5000");
  db.prepare("VACUUM INTO ?").run(workerData.target);
} finally {
  db.close();
}
parentPort.postMessage("done");
