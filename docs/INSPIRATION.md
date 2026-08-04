# Inspiration — what Tiffin takes from Bento, and where it diverges

Tiffin exists because [Bento](https://bento.page) settled an argument. The
claim that an office document could carry its own application — viewer,
editor, the lot — inside a single HTML file sounds like a stunt until you have
one open in front of you. Bento shipped it for slides. Tiffin is the same
claim for prose.

`reference/bento/` is a git checkout of Bento kept locally for reference. It is
gitignored, and it is there to be read, not linked against. **Tiffin shares
Bento's ideas, not its code.** Nothing in `writer/` is derived from Bento's
source; the two projects have no dependency on one another and never will.

## The thesis, inherited whole

Bento's README puts it plainly: *office documents used to be things you had,
now they're things you rent.* Everything both projects do follows from
refusing that trade.

| Idea | Bento | Tiffin |
|---|---|---|
| **One file, forever** | Deck, fonts, images, charts, animation, editor | Prose, styles, paginator, editor |
| **View-source honest** | `#bento-doc`, `application/bento+json` | `#tiffin-doc`, `application/tiffin+json` |
| **It saves itself** | Clone the pristine shell, splice, File System Access with a download fallback | Identical, in `writer/src/save.ts` |
| **Designed for AI** | The document is plain JSON, so any agent with filesystem access can edit it | Same, and the same reason: no plugin, no API, no server |
| **A gate, not an intention** | Conformance checks in the build | `scripts/shell-gate.mjs`, 8 checks; a gate failure is a build failure |

Even the shapes rhyme deliberately. The data block, the `format` +
`version` envelope, the `assets` map of data URIs keyed by name, the
`window.<app>` runtime handle, the packaged Claude Code skill — all of that is
Bento's design, adopted because it was right the first time.

## Where prose forced a different answer

Slides and prose diverge on one thing, and it turns out to be the whole
product: **pages**.

A deck is a list of fixed-size canvases. Every slide is 1280×720 whatever
machine opens it, so a Bento element can carry absolute `x, y, w, h` and be
telling the truth everywhere. Prose has no such luxury. Where a page ends
depends on font metrics, zoom level, and browser — three things the authoring
machine does not control and cannot predict for the reading machine.

That gives Tiffin an invariant Bento does not need:

> **Pagination is derived, never stored.** Automatic breaks are measured at
> open time and live in the view layer as decorations. Only a break the *user*
> forced is a node in the document.

A file that stored computed breaks would lie about itself the moment it
travelled — and travelling is the entire point. The corollary is a stylesheet
rule with teeth: measured block height must not depend on where the bands are.
No `margin-top` on top-level blocks, no positional selectors, no margins that
can escape a container. Three of the five defects found in sprint 1 were
violations of exactly that, which is why `paginate.ts` now checks it at dev
time instead of trusting a comment.

Three smaller divergences follow from the same place:

- **ProseMirror instead of a canvas model.** The schema's `toDOM` *is* the
  renderer, and the same serializer feeds the editor, the static save-time
  preview, and print. One renderer, three surfaces — the property Bento needed
  376 lines of `preview.ts` to reach. See `docs/VISION.md` for the size and
  licence comparison that settled it.
- **We own the paginator.** ~250 lines, and it is the core of the product.
  Inheriting someone else's roadmap for the one thing that makes Tiffin
  Tiffin was not a trade worth making.
- **No collaboration in v1.** Bento's E2EE CRDT with keys living in the file
  is the most impressive thing in it. Tiffin ships without it, because
  shipping without collaboration beats shipping it half-secure.

## What we have not taken yet

Bento has solved several problems Tiffin will hit later, and the answers are
sitting in `reference/bento/` when the time comes: signed self-updates that
write a *new* file so the old one stays as a rollback, a blind relay that
stores ciphertext and learns nothing, and a chart engine with no dependencies.

Tiffin's own gaps are named in `docs/VISION.md` rather than discovered: no
table splitting across pages, no footnotes, no widow/orphan control, no DOCX,
no printed running headers. They are decisions, not surprises.

## Credit

Bento is MIT licensed, by [nybl](https://github.com/nyblnet/bento). Tiffin is
MIT licensed too, and grateful. If you want the slides half of this idea, go
get the original — it is one file and it costs you nothing to try.
