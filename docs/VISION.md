# Tiffin — the document that fits in a file

A word processor that is a single HTML file. Open it in any browser and it *is*
the editor: type into real A4/Letter pages, hit save, and the file rewrites
itself with your document inside. The person you send it to needs nothing.

Bento proved the shape for slides. Tiffin is that shape for prose — and prose
brings one problem slides do not have: **pages**.

## The five invariants

Everything below is a consequence of one decision: the file travels, and it
must still be true on someone else's machine in ten years.

1. **One file, zero requests.** Runtime, styles, fonts, and document ship in
   one `.tiffin.html`. No CDN, no network, no installer. Verified by a gate,
   not by intention.
2. **The document is plain JSON, in plaintext, near the top.** One
   `<script type="application/tiffin+json" id="tiffin-doc">` block. Readable in
   View Source, editable by any agent with filesystem access. The compressed
   base64 payload below it is *runtime only* and contains no user content.
3. **Pagination is derived, never stored.** Automatic page breaks are computed
   from measured layout at open time and live in the view layer as decorations.
   Only a break the *user* forced is a node in the document. A file that stored
   computed breaks would lie about itself the moment it changed machines —
   different fonts, different zoom, different browser.
4. **It saves itself.** Clone the pristine shell at boot, splice the new JSON
   in, write via File System Access with a download fallback. Runtime-injected
   DOM is stripped on the way out, or the file grows on every save.
5. **What you see is what prints.** Screen pagination and print pagination come
   from the same computed break positions, so a PDF is not a second opinion.

## Why ProseMirror, and why we own the paginator

Measured through the real pipeline (esbuild minify → `deflateRawSync` level 9;
on-disk cost is deflated × 1.33 for base64):

| Option | deflated | on disk | license | verdict |
|---|---|---|---|---|
| ProseMirror + own paginator | ~78 KB | ~104 KB | MIT | **chosen** |
| Tiptap + `tiptap-pagination-plus` | 134 KB | ~179 KB | MIT | same engine, +75 KB of API we don't need |
| Paged.js | 100 KB | ~133 KB | MIT | a one-way chunker — cannot be typed into |
| SuperDoc | 2.1 MB | ~2.8 MB | AGPL-3.0 | real DOCX fidelity; ends the one-file story |

ProseMirror is WYSIWYG by construction: the schema's `toDOM` renders the
document, `contenteditable` sits on top, and the *same* serializer produces the
saved thumbnail and the print output. One renderer, three surfaces — the
property bento needed 376 lines of `preview.ts` to get.

The paginator is ~250 lines and it is the core of the product, so we own it
outright rather than inherit someone's roadmap.

## What v1 is not

Named now so they are decisions, not surprises:

- **No table splitting across pages.** A table taller than a page overflows.
- **No footnotes.** The hardest part of paged layout; deferred deliberately.
- **No widow/orphan or keep-with-next control.**
- **No DOCX import/export.** `docx` + `mammoth` measured at 223 KB deflated —
  affordable, but it is a separate sprint and a separate fidelity contract.
- **No collaboration.** Shipping without it beats shipping it half-secure.
- **No print headers/footers.** Browsers do not render `@page` margin-box
  content; on-screen running content is ours, printed running content is the
  browser's. Known gap.

## Sequence

- **Sprint 001 — the file exists.** Paged WYSIWYG editing, self-save, one-file
  build, round-trip gate. *This sprint.*
- **Sprint 002 — durability.** IndexedDB autosave + crash recovery, version
  history, `beforeunload` discipline.
- **Sprint 003 — fidelity.** Table splitting with repeated header rows,
  keep-with-next, widow/orphan.
- **Sprint 004 — interchange.** DOCX in/out, PDF export beyond browser print.
- **Sprint 005 — footnotes.**
