import { commonCopy } from "../lib/i18n/messages/common.js";
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { menuPlacement, scrollClip } from "./anchored-select-placement.js";
export default function AnchoredSelect({
  id: selectId,
  label,
  value,
  onChange,
  options,
  disabled = false,
  required = false,
  describedBy,
  searchLabel,
  query = "",
  onQuery,
  noMatches,
}) {
  const root = useRef(null),
    select = useRef(null),
    list = useRef(null),
    search = useRef(null),
    layer = useRef(null),
    touch = useRef(false),
    typeahead = useRef({
      text: "",
      time: 0,
    });
  const id = useId(),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    [placement, setPlacement] = useState({
      above: false,
      height: 240,
      top: 0,
      left: 0,
      width: 0,
    });
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const visibleIndices = options.flatMap((option, index) =>
    !searchLabel ||
    (option.value && option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      ? [index]
      : [],
  );
  const enabledIndices = visibleIndices.filter((index) => !options[index].disabled);
  function nextActive(index, key) {
    if (key === "Home") return enabledIndices[0] ?? index;
    if (key === "End") return enabledIndices.at(-1) ?? index;
    return (
      (key === "ArrowDown"
        ? enabledIndices.find((item) => item > index)
        : enabledIndices.findLast((item) => item < index)) ?? index
    );
  }
  function show() {
    if (disabled || !options.length) return;
    if (searchLabel) onQuery("");
    setActive(options[selected]?.disabled ? (enabledIndices[0] ?? selected) : selected);
    // A focused select opens the native picker on iOS, which takes the focus from
    // the search. Touch focuses the search within the tap, so the keyboard opens.
    if (touch.current && searchLabel) {
      flushSync(() => setOpen(true));
      search.current?.focus({ preventScroll: true });
      return;
    }
    setOpen(true);
    if (!touch.current) select.current?.focus({ preventScroll: true });
  }
  // The menu lives in a fixed layer outside the field (see the render), so "inside"
  // means the field or the menu.
  const inside = (node) =>
    Boolean(node && (root.current?.contains(node) || layer.current?.contains(node)));
  function choose(index) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    if (touch.current) document.activeElement?.blur();
    else select.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (open && searchLabel) search.current?.focus({ preventScroll: true });
  }, [open, searchLabel]);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      if (!select.current || !layer.current) return;
      const field = select.current.getBoundingClientRect();
      // A field scrolled out of its scroll container closes the menu instead of
      // leaving it floating over the page.
      const clip = scrollClip(root.current);
      if (field.bottom <= clip.top || field.top >= clip.bottom) {
        setOpen(false);
        return;
      }
      const dialog = root.current.closest("dialog")?.getBoundingClientRect(),
        origin = layer.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      setPlacement(
        menuPlacement({
          field,
          origin,
          scale: origin.width / 100 || 1,
          top: Math.max(viewport?.offsetTop || 0, dialog?.top || 0) + 8,
          bottom:
            Math.min(
              (viewport?.offsetTop || 0) + (viewport?.height || innerHeight),
              dialog?.bottom || innerHeight,
            ) - 8,
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(select.current);
    const dialog = root.current.closest("dialog");
    if (dialog) observer.observe(dialog);
    const outside = (event) => {
      if (!inside(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const menu = list.current;
    const option = menu?.querySelector(`[data-index="${active}"]`);
    if (!option) return;
    // Keep keyboard selection visible without scrolling the surrounding dialog.
    // Measured in unrounded rects: clientHeight and offsetHeight round, and with a
    // fractional max-height under CSS zoom WebKit would leave the option clipped.
    const menuBox = menu.getBoundingClientRect(),
      optionBox = option.getBoundingClientRect(),
      style = getComputedStyle(menu);
    const scale = menuBox.width / menu.offsetWidth || 1;
    const viewTop = menuBox.top + parseFloat(style.borderTopWidth) * scale,
      viewBottom = menuBox.bottom - parseFloat(style.borderBottomWidth) * scale;
    if (optionBox.top < viewTop)
      menu.scrollTop -= Math.ceil((viewTop - optionBox.top) / scale);
    else if (optionBox.bottom > viewBottom)
      menu.scrollTop += Math.ceil((optionBox.bottom - viewBottom) / scale);
  }, [open, active]);
  function keydown(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        show();
        if (event.key === "Home") setActive(nextActive(selected, "Home"));
        if (event.key === "End") setActive(nextActive(selected, "End"));
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        choose(active);
        return;
      }
      setActive((index) => nextActive(index, event.key));
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (searchLabel) {
        if (!open) show();
        onQuery(event.key);
        setActive(-1);
        return;
      }
      const now = Date.now();
      typeahead.current = {
        text:
          (now - typeahead.current.time < 700 ? typeahead.current.text : "") +
          event.key.toLowerCase(),
        time: now,
      };
      if (!open) show();
      const index = options.findIndex(
        (option) =>
          !option.disabled &&
          option.label.toLowerCase().startsWith(typeahead.current.text),
      );
      if (index >= 0) setActive(index);
    }
  }
  return (
    <div
      ref={root}
      className="anchored-select"
      // The field stays visible above the on-screen keyboard while its search has
      // focus; the options then open where there is room (lib/keyboard-inset.js).
      data-keyboard-reveal=""
      data-keyboard-reveal-id={id}
      onPointerDownCapture={(event) => {
        touch.current = event.pointerType === "touch";
      }}
      onBlur={(event) => {
        // iOS blurs without a target while it finishes a tap; a tap outside
        // closes the menu through its pointerdown instead.
        if (touch.current && !event.relatedTarget) return;
        if (!inside(event.relatedTarget)) setOpen(false);
      }}
    >
      <select
        ref={select}
        id={selectId}
        aria-label={label}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        value={value}
        disabled={disabled}
        required={required}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(false);
        }}
        onPointerDown={(event) => {
          // iOS ends a tap by blurring the element focused during it, which would
          // close the menu and its search at once. Touch toggles on click instead,
          // and its pointerdown keeps its default so that WebKit dispatches the click.
          if (touch.current) return;
          event.preventDefault();
          open ? setOpen(false) : show();
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          if (event.detail === 0 || touch.current) open ? setOpen(false) : show();
        }}
        onKeyDown={keydown}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            aria-hidden={open || undefined}
          >
            {option.label}
          </option>
        ))}
      </select>
      {open &&
        // A fixed layer in the dialog (top layer) or the page: no scroll container or
        // card clips the menu, and it stacks above sticky bars (--z-dropdown).
        createPortal(
          <div ref={layer} className="anchored-layer" data-keyboard-reveal-for={id}>
            <div
              ref={searchLabel ? undefined : list}
              id={searchLabel ? undefined : id}
              role={searchLabel ? undefined : "listbox"}
              aria-label={searchLabel ? undefined : commonCopy.selectOptionsLabel(label)}
              className={`anchored-options ${placement.above ? "above" : ""} ${searchLabel ? "searchable" : ""}`}
              style={{
                maxHeight: placement.height,
                top: placement.top,
                left: placement.left,
                width: placement.width,
              }}
            >
              {searchLabel && (
                <div className="anchored-search">
                  <input
                    ref={search}
                    type="search"
                    role="combobox"
                    aria-label={searchLabel}
                    aria-expanded="true"
                    aria-controls={id}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      enabledIndices.includes(active) ? `${id}-${active}` : undefined
                    }
                    value={query}
                    placeholder={searchLabel}
                    // A filter, not a form field: no contact or password autofill.
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="search"
                    onChange={(event) => {
                      onQuery(event.target.value);
                      setActive(-1);
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpen(false);
                        select.current?.focus({ preventScroll: true });
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        if (enabledIndices.includes(active)) choose(active);
                      } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                        event.preventDefault();
                        setActive((index) => nextActive(index, event.key));
                      }
                    }}
                  />
                </div>
              )}
              <div
                className={searchLabel ? "anchored-search-results" : undefined}
                ref={searchLabel ? list : undefined}
                id={searchLabel ? id : undefined}
                role={searchLabel ? "listbox" : undefined}
                aria-label={
                  searchLabel ? commonCopy.selectOptionsLabel(label) : undefined
                }
              >
                {visibleIndices.map((index) => {
                  const option = options[index];
                  return (
                    <button
                      type="button"
                      role="option"
                      id={`${id}-${index}`}
                      data-index={index}
                      tabIndex={-1}
                      key={option.value}
                      disabled={option.disabled}
                      aria-selected={option.value === value}
                      className={active === index ? "active" : ""}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerMove={() => {
                        if (!option.disabled) setActive(index);
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        choose(index);
                      }}
                    >
                      {option.label}
                      {option.value === value && <span aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
                {searchLabel && !visibleIndices.length && (
                  <p className="field-description" role="status">
                    {noMatches}
                  </p>
                )}
              </div>
            </div>
          </div>,
          root.current?.closest("dialog") || document.body,
        )}
    </div>
  );
}
