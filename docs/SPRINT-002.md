# Sprint 002 — review: comments and suggestions that survive the post

Multi-party review for a format with no server, no CRDT, and no live connection.
The file goes out, comes back annotated, and merges.

## The contract this sprint adds

> **The base is frozen while a document is out for review.** Reviewers add
> comments and propose changes; they do not rewrite the prose. Every returned
> copy therefore has a byte-identical `body`, and merging N copies is a union of
> three keyed maps rather than an N-way text merge.

That one restriction is what buys multi-party review with no CRDT, no relay, and
no new dependency. It is enforced by convention and *checked* by `baseRev`, not
enforced by lock — a reviewer who edits anyway produces a copy that says so.

## Why annotations live beside the body, not as marks in it

The obvious design is a `comment` mark on the covered text, which ProseMirror
maps through edits for free. It is the right answer for a single editor and the
wrong one here.

A suggestion changes the text — an insertion adds characters, a deletion strikes
them through but keeps them. So a reviewer's `body` stops matching the base, two
reviewers' positions stop matching each other, and the merge is back to rebasing
diffs. Keeping annotations **out of band** keeps every circulated `body`
byte-identical:

```json
"review": {
  "mode": "reviewing",
  "baseRev": "fnv1a:9f2c4b17…",
  "people":      { "p_a1": { "name": "Alice", "color": "#2f7d4f" } },
  "comments":    { "c_a1": { "author":"p_a1", "created":"…", "threadOf":null,
                             "resolved":false, "from":412, "to":418,
                             "quote":"as it read when written",
                             "body":"Is this Q3 or Q4?" } },
  "suggestions": { "s_a1": { "author":"p_a1", "created":"…", "kind":"replace",
                             "from":980, "to":1004, "quote":"the old wording",
                             "text":"the proposed wording", "status":"open" } }
}
```

The body stays a clean, valid, readable document — invariant 2 is untouched, and
View Source shows prose plus a legible list of annotations.

## How this sits with the five invariants

| Invariant | Effect |
|---|---|
| 1 — one file, zero requests | Untouched. Merge is a second **local file**, opened with a file input. No network is added. |
| 2 — plain JSON, plaintext | Strengthened. Annotations are pure data with no executable content; positions and quotes are legible. |
| 3 — nothing derived is stored | Held. Highlights, gutter placement and strike-through rendering are `Decoration`s computed on open. Only authored intent — who said what, about which range — is stored. |
| 4 — it saves itself | Annotations grow the file monotonically, so this sprint owes a **purge** for resolved comments and settled suggestions. |
| 5 — WYSIWYG = what prints | Review chrome is screen-only. Print is always the clean document in v1; a suggestions-visible print mode is deferred rather than half-done. |

**Positions are authored data, not derived data.** They are a claim about where
a remark belongs, exactly as a forced page break is a claim about where a page
should end. That is why they may be stored while a computed break may not.

## Positions must map, even with a frozen base

The base is frozen for *reviewers*. The **owner** edits with comments on screen,
so anchors have to move as they type or every annotation rots on first keystroke.

Anchors therefore live in plugin state and are mapped through `tr.mapping` on
every transaction; `snapshot()` reads the mapped values back. The file stores
the position as of the last save, the session keeps it live, and ProseMirror's
own mapping is the only thing doing arithmetic.

`quote` is the integrity check. Before a suggestion is applied, the text at
`[from, to]` must still equal `quote`; if it does not, the suggestion is
**stale** and is shown rather than applied. The same check catches anchors that
drifted through a merge.

## Merge is a union, and `baseRev` decides whether it is allowed

`baseRev` is a hash of the clean body. Cheap and non-cryptographic — it detects
change, it does not resist an adversary, and `crypto.subtle` is async and needs
a secure context that `file://` does not always provide.

*Import review from another copy* opens a second `.tiffin.html`, reads its
`#tiffin-doc` block, and:

1. **`baseRev` matches** → union `people`, `comments`, `suggestions` by id, skip
   ids already present, report the count added.
2. **`baseRev` differs** → refuse, and say why: that copy's prose was edited, so
   its positions describe a different document.

The point is not that it always merges. It is that the safe case is automatic
and the unsafe case is loud.

## Phases

1. **Model.** `Review` types on the envelope, `baseRev` hashing, `docContentKey`
   includes review so annotating marks the file dirty.
2. **Anchors and rendering.** `review.ts`: plugin state, position mapping,
   inline highlight decorations, strike-through and proposed-text widgets.
3. **Panel.** A docked right rail listing comments and suggestions, with
   click-to-scroll and active highlighting.
4. **Authoring.** Add comment from selection, reply, resolve; propose
   replacement / insertion / deletion from selection.
5. **Settle.** Accept and reject, with `quote` verification and remapping of
   everything below the applied change.
6. **Merge and purge.** Import from another copy; purge resolved and settled.

## Verification

`npm test` bundles `test/review.test.ts` with esbuild and runs it in Node —
`EditorState` and `Transaction` are pure, and the anchor arithmetic is the part
that fails silently. 43 checks cover mapping, boundary behaviour, staleness,
accept/reject/rebase, threads, purge, merge idempotence and `baseRev`.

It earned its keep immediately: **`assoc` was inverted on both anchor ends**, so
every annotation quietly swallowed text typed against its edges. The anchors
still tracked their text, the UI looked correct, and nothing threw — exactly the
kind of defect that reaches a user as "my comment is on the wrong words now."

The rendering path needs a browser and is checked by driving the built shell
over CDP in headless Chrome: boot, rail opens without overlapping the page,
select → comment → card and highlight rendered, pagination unchanged, and a
save round-trip that keeps the remark while stripping every scrap of review
chrome from the file.

One incidental finding: `obscura` cannot host this app at all — its V8 DOM has
no `DecompressionStream`, so the compressed shell never inflates. Real browsers
are fine. Worth knowing before anyone tries to smoke-test a `.tiffin.html` with
a lightweight scraper.

## What this sprint is not

Named now so they are decisions rather than surprises.

- **No concurrent prose editing.** One owner edits; everyone else annotates. Two
  people rewriting paragraph four is what a CRDT is for, and that is Sprint 003
  at the earliest.
- **No margin bubbles beside the anchor.** A gutter inside the page margin is
  the nicer design, but the paginator's measurement contract makes it the kind
  of change that silently drifts pagination. A docked rail outside `.tf-column`
  has zero effect on measurement. The gutter is a later, deliberate sprint.
- **No live presence.** No cursors, no typing indicators, no notification.
- **No identity verification.** A `people` entry is self-asserted. Signing
  authorship needs a keypair and a trust story, and neither is free.
- **No suggestions for structural change.** Replace, insert and delete over an
  inline range. Splitting a paragraph, changing a heading level or restructuring
  a table are not proposable — they are edits.
- **No printed review chrome.** Print is the clean document.

## Delivery risk worth writing down

A 127 KB self-modifying HTML attachment is exactly the shape mail systems
quarantine. The round-trip this sprint is built for may need the file zipped to
survive the post. That is a documentation problem, not a code one, but it is the
difference between a feature that works and a feature that works for the user.
