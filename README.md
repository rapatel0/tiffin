# Tiffin

**A word processor that is a single HTML file.** Open it in a browser and it *is*
the editor: type into real A4/Letter pages, press ⌘S, and the file rewrites
itself on disk with your document inside. The person you send it to needs
nothing.

Bento proved the shape for slides. Tiffin is that shape for prose — with the one
thing slides do not need: **pages**.

```
writer/dist-single/Tiffin_Writer.tiffin.html   127 KB, zero network requests
```

## Build

```bash
cd writer
npm install
npm run build:single      # → dist-single/Tiffin_Writer.tiffin.html, then gates it
npm run dev               # dev server with the margin-contract audit enabled
```

`build:single` runs four steps: `tsc` → Vite with `vite-plugin-singlefile` →
`scripts/postbuild-compress.mjs` (deflate the runtime to base64 payloads behind a
~1 KB `DecompressionStream` loader) → `scripts/shell-gate.mjs` (8 conformance
checks). A gate failure is a build failure.

## How it works

| File | Role |
|---|---|
| `writer/src/model.ts` | the `tiffin/doc` JSON model — envelope, `pageSetup`, parse/normalize |
| `writer/src/schema.ts` | the ProseMirror schema and stored Mermaid source |
| `writer/src/mermaid.ts` | local Mermaid rendering for the editor and static output |
| `writer/src/paginate.ts` | measures blocks, computes page breaks, draws them as decorations |
| `writer/src/save.ts` | pristine-clone-and-splice self-save, FSA + download |
| `writer/src/editor.ts` | state, plugins, keymaps, command surface, `@page` generation |
| `writer/src/styles.css` | the measurement contract lives here as much as in the paginator |
| `scripts/postbuild-compress.mjs` | one-file build |
| `scripts/shell-gate.mjs` | the conformance gate |

Read [docs/VISION.md](docs/VISION.md) for the five invariants and why each one
exists, and [docs/SPRINT-001.md](docs/SPRINT-001.md) for what is done, what is
deliberately not, and the five defects the verification pass turned up.

## The one thing to understand before changing anything

**Pages are a view, never a document node.** The JSON stores your prose plus the
breaks a human explicitly asked for; every automatic break is measured on open
and exists only as a `Decoration`. A break position is true for one set of font
metrics, one zoom level, one browser — writing it into the file would make the
document lie about itself the moment it travelled, and travelling is the whole
point of the format.

The corollary is a stylesheet rule with teeth: **measured block height must not
depend on where the bands are.** No `margin-top` on top-level blocks, no
positional selectors, no margins that can escape a container. Three of the five
bugs found in sprint 1 were violations of exactly that. `paginate.ts` now checks
it at dev time instead of trusting the comment.

## For AI agents

The document is plain JSON in a `<script type="application/tiffin+json"
id="tiffin-doc">` block near the top of the file. Edit that block in place;
escape every `<` as `<`. Do not write page breaks for pagination — only
`{"type":"page_break"}` for a break the author demanded. Store a Mermaid diagram
as `{"type":"mermaid_diagram","attrs":{"source":"flowchart LR\\n  A --> B"}}`.
Tiffin stores only the source and renders the SVG locally.

In a running file, `window.tiffin` exposes `{ doc, serialize(), serializeFile(),
loadDoc(), save(), renderStatic(), renderStaticAsync() }`. Use
`renderStaticAsync()` when the result must include rendered Mermaid SVG.

Claude Code users get a packaged `tiffin-docs` skill: it bundles the runtime
shell, ships templated documents, and splices the JSON without disturbing the
compressed runtime below it.

## Lineage

Bento settled the argument that a document can carry its own application. Tiffin
takes that thesis whole — one file, view-source honest, self-saving,
agent-editable — and diverges on the one thing prose has that slides do not:
pages are derived, never stored. [docs/INSPIRATION.md](docs/INSPIRATION.md) is
the full accounting of what is borrowed and what prose forced a different answer
to.

MIT licensed. `reference/bento/` is a git checkout of Bento, kept for reference;
Tiffin shares its ideas, not its code.
