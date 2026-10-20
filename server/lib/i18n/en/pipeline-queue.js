/** English counterpart of de/pipeline-queue.js with identical keys. */
export const pipelineQueue = Object.freeze({
  itemNotFound: "This item is no longer in the queue.",
  invalidTask: "Enter a task of at most 64 KiB.",
  invalidBaseBranch:
    "The base branch may be at most 300 characters long and contain no control characters.",
  invalidExternalRef:
    "The external reference may be at most 120 characters long and contain no control characters.",
  full: "This project's queue is full: at most 200 items may wait.",
  notWaiting: "Only waiting items can be moved.",
  invalidMove: "An item can only be moved up or down.",
  notFailed: "Only an item whose start failed can be started again.",
  starting: "This item is being started. Try again in a moment.",
  invalidSettings:
    "Concurrent runs must be a whole number from 1 to 20, and whether waiting runs count must be yes or no.",
  startFailed: "The run could not be started.",
  closed: "The queue is closed.",
});
