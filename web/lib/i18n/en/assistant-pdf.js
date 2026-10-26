export const assistantPdfCopy = {
  enable: "Read PDFs",
  description:
    "Reads PDF files in its workspace with its own model, page images included if that model accepts images. Otherwise the PDF fallback model from Connections reads them, or, without one, only their text is read.",
  reference: (name) => `PDF fallback · ${name}`,
  notSet: "Not chosen",
  title: "PDF reading",
  intro:
    "Agents read PDFs with their own model when it accepts images. This optional fallback model reads them for agents whose model does not; without it, those agents read only the text of PDFs, not scanned pages or pages without text.",
  model: "Fallback model",
  hint: "Used only by agents with “Read PDFs” switched on whose own model does not accept images. Their PDFs' text, and page images if this model accepts images, are sent to it. Changes can restart the agents' service.",
  textOnly:
    "This model does not accept images either: it reads the text of PDFs, but not scanned pages or pages without text. Choose a model that accepts images to read those too.",
  ready: "Ready",
  status: {
    notSet:
      "No fallback model: agents whose model does not accept images read only the text of PDFs.",
    connectionMissing: "The chosen connection no longer exists. Choose another model.",
    connectionUnavailable:
      "The chosen connection is not usable right now: check its key or sign-in.",
  },
  save: "Save fallback model",
  remove: "Remove fallback model",
  noConnections: "Add a model connection under Model access first.",
};
