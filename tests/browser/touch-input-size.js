import { expect } from "@playwright/test";

// iOS Safari zooms into any text-entry control under 16px on focus, so every view and
// form keeps its controls at 16px or more on a phone.
export const phone = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};

export async function smallControls(page, view) {
  return page.evaluate((view) => {
    const skipped = ["checkbox", "radio", "range", "color", "file", "hidden"];
    const buttons = ["button", "submit", "reset", "image"];
    const controls = document.querySelectorAll(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    );
    const describe = (element) => {
      const label =
        element.getAttribute("aria-label") ||
        element.labels?.[0]?.innerText ||
        element.getAttribute("placeholder") ||
        element.getAttribute("name") ||
        "";
      const classes = [...element.classList].map((name) => `.${name}`).join("");
      const parent = element.parentElement;
      const context = parent
        ? `${parent.tagName.toLowerCase()}${[...parent.classList].map((name) => `.${name}`).join("")} > `
        : "";
      return `${context}${element.tagName.toLowerCase()}${classes} "${label.trim().slice(0, 40)}"`;
    };
    return [...controls]
      .filter((element) => {
        const type = (element.getAttribute("type") || "").toLowerCase();
        if (element.tagName === "INPUT" && [...skipped, ...buttons].includes(type))
          return false;
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          element.checkVisibility({ checkVisibilityCSS: true })
        );
      })
      .map((element) => ({
        element,
        size: parseFloat(getComputedStyle(element).fontSize),
      }))
      .filter(({ size }) => size < 16)
      .map(({ element, size }) => `${view}: ${describe(element)} ${size}px`);
  }, view);
}

export async function expectTouchSized(page, view) {
  const small = await smallControls(page, view);
  // Soft, so one run lists every view of a walk that still has small controls.
  expect.soft(small, `Text-entry controls under 16px:\n${small.join("\n")}`).toEqual([]);
  // The larger text must still fit the phone without sideways scrolling.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect.soft(overflow, `${view} scrolls sideways`).toBeLessThanOrEqual(0);
}
