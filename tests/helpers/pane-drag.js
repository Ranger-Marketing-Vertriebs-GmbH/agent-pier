// Synthetic drags of split view payloads for browser specs. A DataTransfer built in the
// page keeps its data readable while hovering, so drop zones decide as they do for a
// drag that started in the page.
const PANE_MIME = "application/x-agentpier-pane";

/** A DataTransfer in the page carrying `payload` (or OS files with `{ files }`). */
export function paneTransfer(page, payload) {
  return page.evaluateHandle(
    ({ mime, payload: value }) => {
      const transfer = new DataTransfer();
      if (value?.files)
        for (const name of value.files)
          transfer.items.add(new File(["fixture"], name, { type: "text/plain" }));
      else transfer.setData(mime, JSON.stringify(value));
      return transfer;
    },
    { mime: PANE_MIME, payload },
  );
}

// Dispatches `types` at the point for `side` of the locator's box: 5 % from that edge,
// the centre for "center"; the events go to the element under that point.
async function dispatchAt(locator, side, transfer, types) {
  await locator.evaluate(
    (element, { side: where, transfer: data, types: names }) => {
      const rect = element.getBoundingClientRect();
      const at = {
        left: [0.05, 0.5],
        right: [0.95, 0.5],
        top: [0.5, 0.05],
        bottom: [0.5, 0.95],
        center: [0.5, 0.5],
      }[where];
      const x = rect.left + rect.width * at[0];
      const y = rect.top + rect.height * at[1];
      const target = document.elementFromPoint(x, y) ?? element;
      for (const type of names)
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: x,
            clientY: y,
            dataTransfer: data,
          }),
        );
    },
    { side, transfer, types },
  );
}

/** Hovers a drag over `side` of the locator without dropping. */
export const dragOver = (locator, side, transfer) =>
  dispatchAt(locator, side, transfer, ["dragenter", "dragover"]);

/** Drops at `side` of the locator: dragenter, dragover and drop. */
export const dropOn = (locator, side, transfer) =>
  dispatchAt(locator, side, transfer, ["dragenter", "dragover", "drop"]);

/** The data types a drag started on `locator` carries; the drag ends right away. */
export const dragTypes = (locator) =>
  locator.evaluate((node) => {
    const data = new DataTransfer();
    node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    node.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    return [...data.types];
  });
