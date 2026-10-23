# UI guide

How AgentPier's web UI is built: the design tokens, the shared components and the
rules every new or changed screen follows. The settings layout and save model are in
the [settings pattern](settings-pattern.md); this guide links to it instead of
repeating it.

A live gallery shows every shared component with its variants and states:
**Settings › Operations › Development › Components** (`/settings/components`,
`web/features/gallery/`). Use it to check a component before reaching for a new one.

Contents: [Foundations](#foundations) · [Components](#components) ·
[Rules](#rules) · [Copy](#copy-de-and-en) · [Glossary](#glossary) ·
[Enforcement](#enforcement)

## Foundations

All tokens live in `:root` of `web/styles/base.css`, in three layers:

1. **Palette:** raw colours named by hue and step (`--neutral-01` … `--neutral-31`
   from dark to light, `--warm-*`, `--orange-*`, `--green-*`, `--amber-*`,
   `--red-*`). Only `base.css` holds hex literals.
2. **Semantic colours:** what a colour is for. Features use only these.
3. **Scales:** spacing, radius, type, weight, elevation, z-index, focus, touch and
   safe areas.

The app is dark only. A light theme will redefine the semantic layer (for example
under `:root[data-theme="light"]`) with other palette steps; features that use
semantic tokens then need no change. Alpha tints (`--accent-soft`, `--success-line`,
…) keep their literal value and are redefined together with their base colour.

### Colours

| Token                                                                                    | Use                                                               |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `--surface-page`, `--panel`, `--surface-input`, `--surface-raised`                       | Page background, cards and rows, inputs, raised areas             |
| `--sidebar-bg`, `--header-bg`, `--header-line`                                           | Shell regions                                                     |
| `--popover-bg`, `--popover-raised`, `--scrim`                                            | Menus, popovers, dialog backdrop                                  |
| `--text`, `--text-row`, `--text-message`, `--text-menu`                                  | Body text, row labels, chat text, menu items                      |
| `--muted`, `--text-meta`, `--text-group`, `--text-faint`, `--hint`                       | Secondary text, metadata, group labels, hints                     |
| `--line`, `--divider`, `--divider-soft`                                                  | Borders and dividers                                              |
| `--accent`, `--accent-text`, `--on-accent`                                               | Brand accent, accent text on dark, text on the accent             |
| `--accent-faint`, `--accent-soft`, `--accent-line`, `--surface-accent`                   | Accent tints for selected and highlighted surfaces                |
| `--success`, `--success-muted`, `--warning`, `--error-text`                              | Message text in a tone                                            |
| `--button-secondary-*`, `--pill-*`, `--switch-*`, `--approval-*`                         | The matching component surfaces                                   |
| `--status-working`, `--status-waiting`, `--status-ok`, `--status-error`, `--status-idle` | Status dots, chips and row states (see [Status](#status-colours)) |

### Spacing, radius and type

| Scale     | Tokens                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Spacing   | `--space-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-5` 20px, `-6` 24px, `-8` 32px, `-10` 40px                                |
| Radius    | `--radius-sm` 4px (small controls), `--radius-md` 8px (rows, buttons), `--radius-lg` 12px (cards, dialogs), `--radius-pill` |
| Font size | `--font-size-xs` 11px (the floor), `-sm` 12px, `-md` 13px, `-base` 14px, `-lg` 15px, `-xl` 17px, `-2xl` 20px, `-3xl` 24px   |
| Weight    | `--font-weight-regular` 400, `-medium` 500, `-semibold` 600, `-bold` 700                                                    |

No text is smaller than 11px. Text-entry controls are 16px on phones and touch screens
(the iOS zoom rule in `base.css`, see the
[settings pattern](settings-pattern.md#components-webcomponents-styles-in-webstylessettings-patterncss)).

### Elevation and stacking

| Token                                                                              | Use                                                |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| `--elevation-1`                                                                    | Sticky bars that sit above scrolled content        |
| `--elevation-2`                                                                    | Menus, popovers, dropdowns                         |
| `--elevation-3`                                                                    | Dialogs and sheets                                 |
| `--z-base` 1, `--z-sticky` 20, `--z-dropdown` 50, `--z-overlay` 80, `--z-toast` 90 | Stacking order; no other z-index values in new CSS |

Native modal dialogs (`Modal`, `Sheet`, `SidePanel`, `ImageViewer`) use the browser's
top layer and need no z-index.

### Focus, touch and safe areas

- `--focus-ring` (`2px solid var(--accent)`) and `--focus-ring-offset`: every focus
  outline is `outline: var(--focus-ring)` on `:focus-visible`. `base.css` already
  gives buttons, links and fields this ring; add one only for custom controls.
- `--touch-target` (44px): the minimum size of a tap target on phones and touch
  screens.
- `--safe-area-inset-top`, `-right`, `-bottom`, `-left`: the device safe areas
  (`env(safe-area-inset-*)`). Use the variables, not `env()`, so browser tests can
  emulate a notch or home indicator.

### Breakpoints

| Name   | Width    | CSS                                                        | JS (`web/lib/breakpoints.js`)                   |
| ------ | -------- | ---------------------------------------------------------- | ----------------------------------------------- |
| phone  | ≤ 700px  | `@media (max-width: 700px)`; above it `(min-width: 701px)` | `mediaQueries.phone`, `mediaQueries.abovePhone` |
| tablet | ≤ 1150px | `@media (max-width: 1150px)`                               | `mediaQueries.tablet`                           |
| wide   | ≥ 1500px | `@media (min-width: 1500px)`                               | `mediaQueries.wide`                             |

Media queries cannot read custom properties, so CSS repeats these numbers. JS uses
`breakpoints` or `mediaQueries` from `web/lib/breakpoints.js` with `useMediaQuery`
(`useMobileLayout` is the phone query). `(any-pointer: coarse)` is fine next to a
width for touch rules.

## Components

Shared components live in `web/components/`. Before building a control, check the
gallery; if nothing fits, add the primitive there (and to this table and the gallery)
instead of building a one-off in a feature.

### Page structure

| Component       | Purpose and use                                                                                                                                                                                                                          | Accessibility                                                                        | File                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| `SettingsShell` | Page header (title, subtitle, description, actions), tabs row, 720px content column, bottom bar slot. Use for every settings-like page; `leading="menu"` on top-level pages, `"back"` on subpages. Not for chat, terminal or file views. | One `h1`; the leading button carries `aria-label` and `aria-expanded` for the menu.  | `web/components/SettingsShell.jsx` |
| `UnderlineTabs` | Tabs of a page. Fills the row on phones, scrolls with an edge fade. Use instead of custom tablists. Not for a two- or three-way value choice (use `Segmented`).                                                                          | `role="tablist"`, roving `tabIndex`, arrow keys, Home/End; panels need matching ids. | `web/components/UnderlineTabs.jsx` |
| `ListDetail`    | List beside its detail on desktop, list then detail on phones.                                                                                                                                                                           | The list is a `nav` with a label; the selected item has `aria-current`.              | `web/components/ListDetail.jsx`    |
| `GroupLabel`    | Uppercase label above a card, with optional ⓘ hint and one text action ("+ Add").                                                                                                                                                        | Renders a heading (`h2` by default); give its `id` to the card's `labelledBy`.       | `web/components/GroupLabel.jsx`    |
| `ListCard`      | A group of rows. `disabled` dims a group that does not apply yet.                                                                                                                                                                        | `role="group"` named by `label` or `labelledBy`.                                     | `web/components/ListCard.jsx`      |

### Rows and controls

| Component                                           | Purpose and use                                                                                                                                                                                                             | Accessibility                                                                        | File                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| `ListRow`                                           | Label and sub line, trailing `value` (`unknownValue` "—" until known) or `status` (`ok`, `warn`, `error`), chevron when it navigates, ⋯ `menu`, trash `onDelete`, ⓘ `hint`, `disabled`, `current`. Variants in the gallery. | Navigating rows are links (`href` + `onClick`) or buttons; icon buttons have labels. | `web/components/ListRow.jsx`        |
| `ToggleRow`                                         | A binary setting: a switch (`<input type="checkbox" role="switch">`).                                                                                                                                                       | The row's label names the switch; the sub line describes it.                         | `web/components/ListRow.jsx`        |
| `NumberRow`, `SelectRow`, `RadioRow`, `CheckboxRow` | Number, native select, radio and checkbox rows (with optional pill such as "stdio").                                                                                                                                        | As `ToggleRow`.                                                                      | `web/components/ListRow.jsx`        |
| `CheckRow`                                          | A checkbox whose whole surface toggles it, for multi-select lists in dialogs.                                                                                                                                               | Title names, subtitle describes the checkbox.                                        | `web/components/CheckRow.jsx`       |
| `ReferenceRow`                                      | Dashed row "Managed centrally in Accounts" into the owning page.                                                                                                                                                            | A link with `href`, else a button.                                                   | `web/components/ReferenceRow.jsx`   |
| `Segment`, `Segmented`                              | A choice between two to four short values. `Segmented` is the settings look. Not for page navigation (use `UnderlineTabs`).                                                                                                 | Native radios in a `radiogroup`.                                                     | `web/components/Segment.jsx`        |
| `AnchoredSelect`                                    | A select whose options open anchored below it, optionally with search (`searchLabel`). Use for long or searchable option lists.                                                                                             | A native `select` with a listbox; keyboard and typeahead work.                       | `web/components/AnchoredSelect.jsx` |
| `SearchSelect`                                      | A searchable picker with a trigger button and optional footer, for remote option lists.                                                                                                                                     | Combobox with listbox.                                                               | `web/components/SearchSelect.jsx`   |
| `LanguageSelect`                                    | The language choice (login and general settings).                                                                                                                                                                           | Labelled native select.                                                              | `web/components/LanguageSelect.jsx` |
| `Switch`                                            | A labelled binary setting outside a list card (`role="switch"`); `ToggleRow` is its row form.                                                                                                                               | The label names the switch; the whole label is the target.                           | `web/components/Switch.jsx`         |
| `Checkbox`                                          | A labelled option of an action or one choice among several; `CheckboxRow` and `CheckRow` are the row forms.                                                                                                                 | The label names the box; the whole label is the target.                              | `web/components/Checkbox.jsx`       |
| `PermissionList`                                    | Granted capabilities with check marks.                                                                                                                                                                                      | A labelled list.                                                                     | `web/components/PermissionList.jsx` |
| `AsyncForm`                                         | A dialog form with Cancel and a primary (or danger) submit, busy state and error.                                                                                                                                           | Errors render through `ErrorMessage` (`role="alert"`).                               | `web/components/AsyncForm.jsx`      |
| `Pagination`, `usePagination`                       | Pages of 20 for long client-side lists.                                                                                                                                                                                     | A labelled `nav`; the page number is a polite live region.                           | `web/components/Pagination.jsx`     |

### Buttons and icons

Buttons are CSS classes on a native `<button>` (`.button` variants in `web/app/layout.css`;
`.compact`, `.icon-button`, `.badge`, `.error` and `.loading` in
`web/components/primitives.css`), no component yet:

| Class                 | Use                                                                            |
| --------------------- | ------------------------------------------------------------------------------ |
| `.button.primary`     | The one main action of a view, dialog or bar.                                  |
| `.button.secondary`   | Other actions, Cancel.                                                         |
| `.button.danger`      | The confirming action of a destructive confirmation (Delete, Remove, Discard). |
| `.button.destructive` | A quieter destructive action shown next to others (Revoke).                    |
| `.button.text`        | A low-emphasis action in sheets (Cancel).                                      |
| `.compact`            | Dense rows and toolbars on desktop only; phones keep the 44px target.          |
| `.icon-button`        | An icon-only action; always with `aria-label`.                                 |

`Icon` (`web/components/Icon.jsx`) draws the line icons; the gallery lists every name.
`ProviderMark` draws CLI marks. Icons are `aria-hidden`; the button carries the label.

### Dialogs and overlays

| Component             | Purpose and use                                                                                                                                                                                                                                                          | Accessibility                                                                   | File                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `Modal`               | A dialog with title and close button; `footer` gives a scrolling body and sticky actions. A bottom sheet on phones.                                                                                                                                                      | Native modal `<dialog>`, labelled by its title; Escape honours `closeDisabled`. | `web/components/Modal.jsx`               |
| `ConfirmDialog`       | Every confirmation (see [Confirmations](#confirmations)): `title` names the object, `body` the consequence, `confirmLabel` repeats the verb; `destructive` for danger, else primary; `focusCancel`; async `onConfirm` with busy state and error; `children` for details. | As `Modal`; a destructive one starts on Cancel.                                 | `web/components/ConfirmDialog.jsx`       |
| `Sheet`               | A short choice with more than two answers: bottom sheet on phones, centred 420px dialog on desktop.                                                                                                                                                                      | As `Modal`.                                                                     | `web/components/Sheet.jsx`               |
| `UnsavedChangesSheet` | "Save changes?" with Save and switch (or `saveLabel` "Save and continue"), Discard, Cancel; `body` and `children` for page-specific text and errors; `saveDisabled` while nothing can be saved. The only unsaved-changes dialog (settings, Pipelines, Files).            | As `Sheet`.                                                                     | `web/components/UnsavedChangesSheet.jsx` |
| `SidePanel`           | A side panel for a longer form or preview beside the page.                                                                                                                                                                                                               | Native modal dialog.                                                            | `web/components/SidePanel.jsx`           |
| `ImageViewer`         | Full-size image with zoom, download and share.                                                                                                                                                                                                                           | Native modal dialog; focus returns to the opener.                               | `web/components/ImageViewer.jsx`         |
| `useAlertDialogFocus` | The inline variant: a `role="alertdialog"` confirmation inside a row or card, for cheap or reversible actions and wizard steps. Same texts, colours and order as `ConfirmDialog`.                                                                                        | Focus moves in, Tab cycles, Escape cancels, focus returns.                      | `web/components/useAlertDialogFocus.js`  |
| `SaveBar`             | Bottom bar of a draft: Cancel and Save; Reload and Overwrite on a conflict; partial and error notes.                                                                                                                                                                     | A labelled region; notes are alerts.                                            | `web/components/SaveBar.jsx`             |

### Feedback

| Component       | Purpose and use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | File                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `StatusDot`     | The only status dot: tones `working`, `waiting`, `ok`, `error`, `warning`, `idle`, `pending`, `unknown`; `pulse`; `label` when it is the only sign. Map feature states with `activityTone` / `chipTone` (`status-tones.js`); `className` only positions it.                                                                                                                                                                                                                                    | `web/components/StatusDot.jsx`     |
| `StatusChip`    | A state with a dot: `ok`, `error`, `neutral`, `pending`, `running`, `waiting`; `decision`; `pill`.                                                                                                                                                                                                                                                                                                                                                                                             | `web/components/StatusChip.jsx`    |
| `ErrorMessage`  | An error as `role="alert"`; renders nothing without an error.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `web/components/ErrorMessage.jsx`  |
| `InfoHint`      | ⓘ disclosure that reveals a hint verbatim; never a tooltip. Built into `ListRow` and `GroupLabel`.                                                                                                                                                                                                                                                                                                                                                                                             | `web/components/InfoHint.jsx`      |
| `LearnMore`     | A short hint with the full explanation behind a disclosure.                                                                                                                                                                                                                                                                                                                                                                                                                                    | `web/components/LearnMore.jsx`     |
| `CopyButton`    | Copies `text` and reports Copied / failed in a live region; the label names what it copies; `iconOnly`; `onFailed` to reveal the text. `useCopy` is its hook, `writeClipboard` (`web/lib/clipboard.js`) the plain write.                                                                                                                                                                                                                                                                       | `web/components/CopyButton.jsx`    |
| `CodeBlock`     | Code with an icon copy button (built on `useCopy`).                                                                                                                                                                                                                                                                                                                                                                                                                                            | `web/components/CodeBlock.jsx`     |
| `ActivityRow`   | One step an agent took (an SSH or shell command, a tool call) as a compact row: icon, label, one-line `detail` with an ellipsis, a `StatusChip` (`status`, `tone`); it opens to `children` (rendered only while open unless `keepMounted`), e.g. a wrapping `CodeBlock` (`className="activity-row-code"`, `copyText`, `copyLabel`) and an `.activity-row-facts` list. The head is a button with `aria-expanded`.                                                                               | `web/components/ActivityRow.jsx`   |
| `ActivityGroup` | Consecutive tool calls of one agent turn as one `ActivityRow`, shut by default, in agent chats and session chats alike: `label` ("Agent activity", or e.g. "SSH activity"), "`count` calls · `summary`" (the host, or the main tools from `toolSummary`, e.g. "Bash 5 · Edit 2"), and one chip: "Running" while `running`, "N failed" for `failed` (error tone, visible while shut), "Done" when `done`. `children` are the calls' own rows and stay mounted. A single call stays a plain row. | `web/components/ActivityGroup.jsx` |

### Planned components

These do not exist yet; they are planned in follow-up tickets.
Until they land, follow the rule for each and use the closest existing piece.

| Component    | Replaces                                      | Until then                                           |
| ------------ | --------------------------------------------- | ---------------------------------------------------- |
| `Menu`       | Five `role="menu"` implementations            | `extensions/RowMenu.jsx` (roving focus) as reference |
| `Notice`     | 17 notice and banner classes                  | `ErrorMessage`, `.save-bar-note`                     |
| `EmptyState` | 17 empty-state classes                        | A short sentence plus one action                     |
| `Loading`    | Three spinner animations, ad-hoc loading text | `<p role="status">` with the loading copy            |

## Rules

### Confirmations

- Confirm only what is destructive or hard to undo: deleting, removing access,
  discarding work, overwriting. Do not confirm cheap, reversible actions.
- Use `ConfirmDialog`. The inline variant (`useAlertDialogFocus`) is only for cheap or
  reversible actions inside a row or a wizard step. Never `window.confirm`, `alert` or
  `prompt` (`nativeDialogs` in [Enforcement](#enforcement)).
- The title asks the question with the object's name ("Delete backup 'nightly'?"), the
  body says what is lost, the buttons repeat the verb ("Delete", not "OK" or "Yes").
- The confirming destructive button is `.button.danger`; Cancel is secondary or text.
  On desktop Cancel comes first and the action last (right); in a phone sheet the
  action is on top and Cancel below. Danger buttons have the same height as primary
  ones.
- Do not use danger styling for actions that are not destructive (creating a pull
  request, continuing after a gate). Primary styling never marks a destructive action.

### Verbs

- One verb per concept, as the [glossary › actions](ui-glossary.md#actions) defines:
  **Delete** (the data is gone), **Remove** (a reference is detached), **Revoke**
  (access ends), **Discard** (a draft is dropped).
- A confirm button repeats the verb of the button that opened it ("Delete" →
  "Delete now").
- Buttons are verbs or verb phrases in sentence case: "Save changes", "Open settings".

### Saving, unsaved changes and conflicts

- Settings pages keep a draft and save through one `SaveBar` per tab or subpage
  ([settings pattern › drafts](settings-pattern.md#drafts-and-the-save-chain-weblibsettings)).
  Real actions (add, delete, log in, run) stay immediate.
- Leaving a dirty draft asks with `UnsavedChangesSheet` through the navigation guard
  ([settings pattern › unsaved changes](settings-pattern.md#unsaved-changes-and-navigation-weblibnavigation-guardjs)),
  for the sidebar, tabs, Back/Forward and reload as well as the page's own actions.
  Settings drafts use `useUnsavedChangesGuard`, Pipelines editors `useDraftGuard`
  (Save and continue runs the editor's own save), the file editor
  `useFileNavigationGuard`. No other unsaved-changes dialogs.
- A conflict (the record changed elsewhere) offers "Reload" and "Overwrite anyway" in
  the save bar, never just a "please reload" text.

### Feedback, empty, loading and error states

- Loading: a short status line (`role="status"`) or the component's busy label
  ("Saving …"); keep the old content visible while refreshing.
- Empty: one sentence saying what is missing and, where possible, the one action that
  fills it, using the same verb as the page's add button.
- Errors: `ErrorMessage` near the action that failed, in plain words with what to do
  next. Warnings and errors stay visible; explanations move behind ⓘ.
- Success needs no message when the result is visible; otherwise a short status.

### Forms and disabled controls

- Every field has a visible label. Help text sits below the field or behind ⓘ.
- A disabled control says why: a sub line, hint or note next to it states the reason
  and, if possible, how to enable it. Prefer hiding a control that can never apply.
- Validate on submit and next to the field; keep typed values on errors.

### Binary settings

A setting that is on or off is a switch: `ToggleRow` in a list card, `Switch`
elsewhere, saved through the save bar. Checkboxes (`Checkbox`, `CheckboxRow`,
`CheckRow`) choose several items from a list or set an option of one action. Both share
one look (`web/components/choice.css`); no `accent-color` or bespoke switch styles.

### Navigation and headers

- Page headers come from `SettingsShell` (title, back or menu button, description,
  actions). No bespoke hero headers or bare `h1`s.
- Page tabs are `UnderlineTabs`. The back arrow means "back"; do not reuse it for
  collapse or close.
- Routes, cross-links and the back arrow follow the
  [settings pattern › routes](settings-pattern.md#routes).

#### User app

A restricted [user](users.md) gets her own shell (`web/features/users/UserApp.jsx`),
not the owner's sidebar:

- `UserPage` frames every page with `UserHeader`: title, back arrow to **My agents**
  and the menu button. The menu is a `Sheet` with **My agents**, **Account** and **Sign
  out**; there are no other destinations.
- Pages reuse the shared components (`ListCard`, `ListRow`, `ToggleRow`, `Sheet`,
  `AsyncForm`) and the owner's chat; a user's agent settings show only what her level
  allows and say "The owner manages this." for the rest.
- Notices that concern her privacy (shared agent, **Owner may read chats**) sit above
  the chat, never in a dismissible toast.
- Her app makes HTTP requests only to `/auth` and `/api/me`, and opens only the chat,
  browser-view and dictation WebSockets listed in [Users](users.md#the-users-app); an
  owner path shows "This page does not exist here." under its own address.

### Status colours

One colour per state, from the tokens: working `--status-working` (orange),
waiting `--status-waiting` (light orange), ok `--status-ok` (green), error
`--status-error` (red), idle `--status-idle` (grey). Dots are `StatusDot`; status
text uses `--success` and `--error-text`. "Ready" and "connected" are ok (green), not
accent. Never encode a state by colour alone: add text or an icon.

### Mobile and touch

- Phones are ≤ 700px. Lay out in one column; lists open details as subpages.
- Tap targets are at least `--touch-target` (44px) on phones: `primitives.css` raises
  `.button`, `.compact`, `.icon-button` and labels around a checkbox or radio to 44px
  below 700px. `.compact` and 33px icon buttons are desktop sizes; do not cap them with
  a smaller `min-height` in feature CSS (`tests/browser/touch-target-size.spec.js`).
- Dialogs become bottom sheets on phones (`Modal`, `Sheet` do this already); actions
  stay visible above the home indicator (`--safe-area-inset-bottom`).
- No horizontal page scroll; long values wrap or truncate with the full text available.

### Accessibility

- Every control is reachable and operable by keyboard and shows `--focus-ring`.
- Icon-only buttons have an `aria-label`; decorative icons are `aria-hidden`.
- Dialogs are native `<dialog>` elements labelled by their title, with focus moved in
  and returned on close.
- Text contrast follows the semantic tokens; text is never below 11px.

## Copy (DE and EN)

- Every visible text lives in both catalogs (`web/lib/i18n/de/`, `web/lib/i18n/en/`)
  with matching keys and arguments; import from `web/lib/i18n/messages/`. Shared
  labels (Cancel, Save, Delete, Remove, Retry, …) come from `commonCopy`; do not
  redefine them per feature.
- English uses sentence case for buttons, titles and labels. German uses the informal
  "du" as the rest of the app.
- Ellipses take a space before them in both languages ("Saving …").
- UI paths use "›" with spaces: "Settings › Operations › Backups".
- Terms, action verbs and writing rules are fixed in the [glossary](#glossary).

## Glossary

The DE/EN product terms (Accounts, Session, Tool, Zugang, Berechtigung, Freigabe, …),
the action verbs and the writing rules are in the [UI glossary](ui-glossary.md).
`tests/unit/i18n-terminology.test.js` checks the rules it marks as checked.

## Enforcement

`tests/unit/ui-guide-rules.test.js` checks every file under `web/`:

| Rule             | Fails on                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `hexColours`     | a hex colour in a stylesheet other than `web/styles/base.css`                               |
| `smallFontSizes` | a `font-size` below 11px (px or rem)                                                        |
| `mediaWidths`    | a media query width other than the [breakpoints](#breakpoints), in CSS or a JS query string |
| `focusOutlines`  | a `:focus` outline that does not use `var(--focus-ring)`                                    |
| `nativeDialogs`  | `window.confirm`, `alert` or `prompt`                                                       |

Existing offenders are listed per file in `tests/fixtures/ui-guide-allowlist.json`. The
list only shrinks: a new offender fails the test, and so does a file with fewer
offenders than allowed until its count is lowered (or the entry removed). When you
clean up a file, lower its numbers in the same change; never raise them.

New UI must use these components and tokens. When a screen needs a primitive that does
not exist, add it to `web/components/`, to this guide and to the gallery
(`web/features/gallery/`) in the same change.
