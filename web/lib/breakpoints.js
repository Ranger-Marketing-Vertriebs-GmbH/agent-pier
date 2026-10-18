// The app's breakpoints (docs/ui-guide.md#breakpoints). CSS media queries cannot read
// variables, so stylesheets repeat these numbers; tests/unit/ui-guide-rules.test.js
// accepts no other widths in new CSS or JS media queries.
export const breakpoints = Object.freeze({ phone: 700, tablet: 1150, wide: 1500 });

export const mediaQueries = Object.freeze({
  phone: `(max-width: ${breakpoints.phone}px)`,
  abovePhone: `(min-width: ${breakpoints.phone + 1}px)`,
  tablet: `(max-width: ${breakpoints.tablet}px)`,
  wide: `(min-width: ${breakpoints.wide}px)`,
});

// The widths a media query may name: each breakpoint and the first width past it.
export const allowedMediaWidths = Object.freeze(
  [
    breakpoints.phone,
    breakpoints.phone + 1,
    breakpoints.tablet,
    breakpoints.tablet + 1,
    breakpoints.wide - 1,
    breakpoints.wide,
  ].map((width) => `${width}px`),
);
