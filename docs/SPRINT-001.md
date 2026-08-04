# Sprint 001 — the file exists

**Goal:** a single `Tiffin_Writer.tiffin.html` you can open, type into across
real page boundaries, and save — where the saved file is byte-identical shell
plus new JSON, and opens again unchanged.

## Phases

### 1. Skeleton
- `writer/` app dir, Vite + `vite-plugin-singlefile`, `assetsInlineLimit` at
  100 MB so nothing can stay external.
- `index.html` carries only: head chrome, the `#tiffin-doc` block, a boot
  splash. Every pixel of app UI is injected at runtime under one
  `data-tf-transient` root.

### 2. Document model — `src/model.ts`
- `TiffinDoc = {format, version, docId, title, pageSetup, body, modified}`.
- `pageSetup` is top-level, beside `title`: size, orientation, margins,
  header/footer templates. Page geometry is a document property, not a
  preference — retrofitting it later is painful.
- Running content uses `{page}` / `{pages}` string tokens. Pure data, never
  functions (a document can never carry executable code).
- All lengths are CSS px at 96 dpi. A4 = 794 × 1123.

### 3. Schema — `src/schema.ts`
- `prosemirror-schema-basic` + lists + tables, plus `underline` / `strike`
  marks and **one** structural addition: a `pageBreak` atom node — the only
  break that belongs in the file.
- Blocks carry `margin-bottom` only, never `margin-top`. This kills margin
  collapsing, which makes height measurement arithmetic instead of guesswork.
  Owning the stylesheet is what makes the paginator simple.

### 4. Paginator — `src/paginate.ts`
The load-bearing 250 lines.
- Measure each top-level block once: `offsetHeight` + computed
  `margin-bottom`. Position-independent, so inserted spacers cannot perturb it.
- Walk the blocks arithmetically, emit a break before any block that would
  cross the content bottom; `pageBreak` forces one.
- Render breaks as `Decoration.widget` bands (footer of page *N*, gray gap,
  header of page *N+1*) plus `Decoration.node` marking the block for print.
  **The document is never mutated.**
- Uniform geometry: top margin of *every* page — including the first — comes
  from a band widget, so page 1 is not a special case.
- rAF-debounced, signature-compared, so a decoration-only transaction cannot
  loop.

### 5. Print — same breaks, one stylesheet
- `@page { size: <w>mm <h>mm; margin: … }` generated from `pageSetup`.
- `@media print`: bands hidden, `.tf-break-before { break-before: page }`.
  Print consumes *our* break positions, so screen and paper agree.

### 6. Self-save — `src/save.ts`
- `capturePristine()` before the first DOM mutation.
- Serialize: clone → strip `[data-tf-transient]` → write JSON with every `<`
  escaped as `<` → sync `<title>` → `<!DOCTYPE html>` + `outerHTML`.
- File System Access in place (⌘S), `showSaveFilePicker` for Save As,
  `<a download>` fallback for Firefox/Safari.

### 7. One-file build — `scripts/postbuild-compress.mjs`
- Extract the inline module + app stylesheet, `deflateRawSync(level 9)`,
  base64 into two `text/plain` payload blocks.
- ~1 KB loader inflates via `DecompressionStream`, injects the style
  **marked transient**, boots the module from a blob URL.
- Canonical byte order: head chrome → tooling comment → `#tiffin-doc`
  (plaintext, always) → splash → payloads + loader last.
- If `#tiffin-doc` is empty, fill it from `src/starter.json` so a released
  file is view-source honest on first open.

### 8. Gate — `scripts/shell-gate.mjs`
Non-negotiable, runs on every build:
- zero external subresources (`src=`/`href=` off-origin, `@import`, `url(http`)
- `#tiffin-doc` present, plaintext, outside the payloads, parses as JSON
- no literal `</script>` outside the script elements themselves; tag balance
- survives `DOMParser → splice → outerHTML`, twice, and the second output has
  the same length as the first — the growth-on-save regression is a *test*,
  not a comment

## Definition of done — verified 2026-08-03

- [x] `npm run build:single` produces one HTML file, no external requests —
      **127.0 KB**, 4 script elements, zero network references
- [x] gate passes — 8/8
- [x] typing repaginates without the document JSON changing — inserted ~2500
      characters live, 2 pages → 3 pages, `page_break` count in the document
      stayed at **1** (the author's own), bands 3 → 4
- [x] every page is exactly one page tall — measured drift **−0.17 px** across
      the document (sub-pixel rounding)
- [x] forced page break survives save → reopen
- [x] save twice → **0 bytes** of growth, document JSON identical, `docId`
      stable, no runtime DOM in the saved file
- [x] print breaks where the screen breaks — Chrome `--print-to-pdf` produced
      **2 pages at 210.2 × 297.0 mm** against 2 pages on screen
- [x] `window.tiffin.loadDoc(json)` round-trips

Verified against the compressed shell — the artifact that ships — not the dev
build, in a browser, via `writer/dist-single/Tiffin_Writer.tiffin.html`.

## What the verification pass actually found

Five defects that no static check would have caught. Recorded because each one
is a trap the next person will otherwise walk into:

1. **Pagination only ever ran inside `requestAnimationFrame`.** In any context
   that produces no compositor frames — headless rendering, a tab that loads in
   the background, a hidden iframe opened to print — the callback never fires,
   and the document renders as one enormous page while looking perfectly fine.
   Fixed by racing rAF against a 32 ms timer, first one wins.
2. **Band divs were matched by `.tf-prose > *`** and took a block margin, making
   every page ~10 px too tall.
3. **`:last-child { margin-bottom: 0 }`** made a block's height depend on its
   position — and inserting a band changes which element is last. Positional
   selectors are now banned in the prose stylesheet.
4. **A paragraph's margin escaped its blockquote** by collapsing through the
   container edge, adding ~12 px per blockquote that no child rect accounted
   for. Nested margins are zeroed; spacing inside containers uses `p + p`.
5. **`@page { size: var(--tf-print-w) … }` is silently ignored** — descriptors
   in the page context cannot read custom properties. An A4 document printed as
   five Letter pages. The rule is now generated with literal millimetres.

Defects 2–4 all corrupted the same invariant: measured height must not depend on
where the bands are. `paginate.ts` now enforces it at dev time (`auditMargins`)
rather than trusting a comment.
