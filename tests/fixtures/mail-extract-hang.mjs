// A mail text extractor that never answers: it takes the document and spins.
import { workerData } from "node:worker_threads";

if (workerData) for (;;);
