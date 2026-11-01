// The session viewport variables on the document root are shared by every session
// view on screen; they are cleared only when the last view that holds them lets go.
const names = ["--session-viewport-height", "--session-viewport-top"];

export function createViewportVariables(style) {
  let holders = 0;
  return {
    acquire() {
      let held = true;
      holders += 1;
      return () => {
        if (!held) return;
        held = false;
        holders -= 1;
        if (holders === 0) for (const name of names) style.removeProperty(name);
      };
    },
  };
}
