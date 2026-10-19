export const assistantPdfCopy = {
  enable: "Read PDFs",
  description:
    "Reads PDF files in its workspace with the PDF model chosen in Accounts. Their text and page images go to that model.",
  unavailable: {
    notSet:
      "Choose a PDF model under Accounts › Services for agents › PDF reading first.",
    connectionMissing:
      "The PDF model's connection no longer exists. Choose another one under Accounts › Services for agents › PDF reading.",
    connectionUnavailable:
      "The PDF model's connection is not usable right now. Check it under Accounts.",
    noImages:
      "The PDF model cannot read images. Choose another one under Accounts › Services for agents › PDF reading.",
  },
  reference: (name) => `PDF model · ${name}`,
  notSet: "Not chosen",
  title: "PDF reading",
  model: "PDF model",
  hint: "Every agent with “Read PDFs” switched on reads PDFs with this one model. Its text and page images are sent to it, so choose a model that accepts images. Changes can restart the agents' service.",
  ready: "Ready",
  status: {
    notSet: "No model chosen: agents cannot read PDFs until you choose one.",
    connectionMissing: "The chosen connection no longer exists. Choose another model.",
    connectionUnavailable:
      "The chosen connection is not usable right now: check its key or sign-in.",
    noImages: "The chosen model cannot read images. Choose another model.",
  },
  save: "Save PDF model",
  remove: "Remove PDF model",
  noConnections: "Add a model connection under Model access first.",
};
