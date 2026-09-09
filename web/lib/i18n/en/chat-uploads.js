export const chatUploadsCopy = Object.freeze({
  pendingMessage: "Some file uploads are still pending. Complete or remove them first.",
  interrupted: "Upload interrupted. Please try again.",
  storageFailed: "Could not save the file for recovery.",
  retry: (name) => `Upload again: ${name}`,
  retryButton: "Try again",
  progress: (percent) => `Uploading · ${percent}%`,
  waiting: "Waiting to upload",
  finishing: "Upload transferred · saving",
});
