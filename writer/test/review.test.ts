// SPDX-License-Identifier: MIT
// Logic tests for review anchoring, settling and merge.
//
// These run in Node with no DOM: EditorState and Transaction are pure, and the
// anchor arithmetic is the part that goes wrong silently. Bundle and run with
//   npm run test
// The rendering path (decorations, rail) needs a browser and is not covered
// here — see docs/SPRINT-002.md.

import { EditorState } from 'prosemirror-state'
import { schema } from '../src/schema.ts'
import { bodyRev, emptyReview, type Review } from '../src/model.ts'
import {
  acceptSuggestion,
  addComment,
  addSuggestion,
  getReview,
  isStale,
  mergeReview,
  purgeReview,
  rejectSuggestion,
  resolveComment,
  reviewPlugin,
  textAt,
  threads,
  type Author,
} from '../src/review.ts'
import { TextSelection } from 'prosemirror-state'

let failed = 0
let ran = 0
function check(name: string, cond: boolean, detail = ''): void {
  ran++
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`)
  }
}

const ALICE: Author = { id: 'p_alice', person: { name: 'Alice', color: '#2f7d4f' } }
const BOB: Author = { id: 'p_bob', person: { name: 'Bob', color: '#9c4221' } }

/** "Hello brave world" in one paragraph. Positions: doc 0, para starts at 1. */
function makeState(text = 'Hello brave world', review?: Review) {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
  return EditorState.create({
    doc,
    plugins: [reviewPlugin(review, doc.toJSON())],
  })
}

const select = (s: EditorState, from: number, to: number) =>
  s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)))

// ── anchoring ────────────────────────────────────────────────────────────────
{
  let s = makeState()
  check('textAt reads the range', textAt(s, 7, 12) === 'brave', textAt(s, 7, 12))

  s = select(s, 7, 12)
  const tr = addComment(s, ALICE, 'why brave?')
  check('addComment returns a transaction', !!tr)
  s = s.apply(tr!)
  const [id, c] = Object.entries(getReview(s).review.comments)[0]
  check('comment captured the quote', c.quote === 'brave', c.quote)
  check('comment anchored at the selection', c.from === 7 && c.to === 12, `${c.from}-${c.to}`)

  // Insert 6 chars BEFORE the anchor: it must slide by exactly 6.
  s = s.apply(s.tr.insertText('quite ', 1))
  const moved = getReview(s).review.comments[id]
  check('anchor maps through an edit above it', moved.from === 13 && moved.to === 18, `${moved.from}-${moved.to}`)
  check('anchor still covers its text', textAt(s, moved.from, moved.to) === 'brave')
  check('not stale after an unrelated edit', !isStale(s, moved))

  // Type inside the anchored word: now it IS stale.
  const s2 = s.apply(s.tr.insertText('X', 15))
  const dirty = getReview(s2).review.comments[id]
  check('stale once its own text changes', isStale(s2, dirty), textAt(s2, dirty.from, dirty.to))

  // Delete the anchored text entirely.
  const s3 = s.apply(s.tr.delete(moved.from, moved.to))
  const orphan = getReview(s3).review.comments[id]
  check('orphaned anchor collapses, not lost', orphan.from === orphan.to && !!orphan.quote)
  check('orphan reports stale', isStale(s3, orphan))
}

// ── edge: typing at the boundaries must not widen the anchor ────────────────
{
  let s = makeState()
  s = select(s, 7, 12)
  s = s.apply(addComment(s, ALICE, 'x')!)
  const id = Object.keys(getReview(s).review.comments)[0]
  s = s.apply(s.tr.insertText('!', 12)) // immediately after "brave"
  const a = getReview(s).review.comments[id]
  check('text typed at the end stays outside', a.to === 12, `to=${a.to}`)
  const s2 = s.apply(s.tr.insertText('!', 7)) // immediately before
  const b = getReview(s2).review.comments[id]
  check('text typed at the start stays outside', b.from === 8 && b.to === 13, `${b.from}-${b.to}`)
}

// ── suggestions ──────────────────────────────────────────────────────────────
{
  let s = makeState()
  s = select(s, 7, 12)
  s = s.apply(addSuggestion(s, BOB, 'bold')!)
  const [sid, sug] = Object.entries(getReview(s).review.suggestions)[0]
  check('replace suggestion recorded', sug.kind === 'replace' && sug.text === 'bold', sug.kind)

  const res = acceptSuggestion(s, sid)
  check('accept succeeds', res.ok)
  if (res.ok) {
    s = s.apply(res.tr)
    check('accept rewrote the prose', s.doc.textContent === 'Hello bold world', s.doc.textContent)
    check('accept marked it settled', getReview(s).review.suggestions[sid].status === 'accepted')
  }
}
{
  // Accepting one suggestion must rebase the others in the same transaction.
  let s = makeState('one two three')
  s = select(s, 1, 4) // "one"
  s = s.apply(addSuggestion(s, ALICE, 'ONE')!)
  s = select(s, 9, 14) // "three"
  s = s.apply(addSuggestion(s, BOB, 'THREE')!)
  const ids = Object.keys(getReview(s).review.suggestions)
  const first = ids.find((i) => getReview(s).review.suggestions[i].from === 1)!
  const second = ids.find((i) => i !== first)!

  const res = acceptSuggestion(s, first)
  check('accept with a later suggestion pending succeeds', res.ok)
  if (res.ok) {
    s = s.apply(res.tr)
    const later = getReview(s).review.suggestions[second]
    check('the other suggestion still points at its text', textAt(s, later.from, later.to) === 'three', textAt(s, later.from, later.to))
    check('the other suggestion is not stale', !isStale(s, later))
    const res2 = acceptSuggestion(s, second)
    check('second accept succeeds', res2.ok)
    if (res2.ok) {
      s = s.apply(res2.tr)
      check('both applied', s.doc.textContent === 'ONE two THREE', s.doc.textContent)
    }
  }
}
{
  // A stale suggestion must be refused rather than applied to the wrong text.
  let s = makeState()
  s = select(s, 7, 12)
  s = s.apply(addSuggestion(s, ALICE, 'bold')!)
  const sid = Object.keys(getReview(s).review.suggestions)[0]
  s = s.apply(s.tr.insertText('ZZ', 9))
  const res = acceptSuggestion(s, sid)
  check('stale suggestion is refused', !res.ok, res.ok ? 'accepted anyway' : res.reason)

  const rej = rejectSuggestion(s, sid)
  check('reject always works', rej.ok)
  if (rej.ok) {
    s = s.apply(rej.tr)
    check('reject leaves the prose alone', s.doc.textContent === 'Hello brZZave world', s.doc.textContent)
    check('reject marks it settled', getReview(s).review.suggestions[sid].status === 'rejected')
  }
}
{
  // Insert and delete kinds.
  let s = makeState()
  s = select(s, 6, 6)
  s = s.apply(addSuggestion(s, ALICE, ' very')!)
  let id = Object.keys(getReview(s).review.suggestions)[0]
  check('zero-width selection makes an insert', getReview(s).review.suggestions[id].kind === 'insert')
  let r = acceptSuggestion(s, id)
  if (r.ok) {
    s = s.apply(r.tr)
    check('insert applied', s.doc.textContent === 'Hello very brave world', s.doc.textContent)
  }

  let d = makeState('keep drop keep')
  d = select(d, 6, 11)
  d = d.apply(addSuggestion(d, BOB, '')!)
  id = Object.keys(getReview(d).review.suggestions)[0]
  check('empty text over a selection is a delete', getReview(d).review.suggestions[id].kind === 'delete')
  r = acceptSuggestion(d, id)
  if (r.ok) {
    d = d.apply(r.tr)
    check('delete applied', d.doc.textContent === 'keep keep', JSON.stringify(d.doc.textContent))
  }
}

// ── threads and resolve ──────────────────────────────────────────────────────
{
  let s = makeState()
  s = select(s, 7, 12)
  s = s.apply(addComment(s, ALICE, 'root')!)
  const rootId = Object.keys(getReview(s).review.comments)[0]
  s = s.apply(addComment(s, BOB, 'reply', rootId)!)
  const t = threads(getReview(s).review)
  check('one thread with one reply', t.length === 1 && t[0].replies.length === 1, `${t.length}/${t[0]?.replies.length}`)
  check('reply inherits the root anchor', t[0].replies[0][1].from === t[0].root[1].from)
  check('both people recorded', Object.keys(getReview(s).review.people).length === 2)

  s = s.apply(resolveComment(s, rootId)!)
  check('resolving a root resolves its replies', threads(getReview(s).review).length === 0)
  const { removed } = purgeReview(getReview(s).review)
  check('purge removes the resolved thread', removed === 2, String(removed))
}

// ── merge ────────────────────────────────────────────────────────────────────
{
  const base = makeState()
  const rev = bodyRev(base.doc.toJSON())

  let mine = select(base, 1, 6)
  mine = mine.apply(addComment(mine, ALICE, 'from Alice')!)
  let theirs = select(base, 7, 12)
  theirs = theirs.apply(addComment(theirs, BOB, 'from Bob')!)

  const { review, report } = mergeReview(getReview(mine).review, getReview(theirs).review)
  check('merge adds the other copy’s comment', report.comments === 1, String(report.comments))
  check('merge adds the other person', report.people === 1, String(report.people))
  check('merged review holds both', Object.keys(review.comments).length === 2)

  // Idempotent: merging the same copy twice adds nothing.
  const again = mergeReview(review, getReview(theirs).review)
  check('merge is idempotent', again.report.comments === 0 && again.report.people === 0)

  // baseRev is the precondition, and it must actually detect a prose edit.
  const edited = base.apply(base.tr.insertText('X', 1))
  check('baseRev is stable for the same body', bodyRev(base.doc.toJSON()) === rev)
  check('baseRev changes when prose changes', bodyRev(edited.doc.toJSON()) !== rev)
}

// ── guards ───────────────────────────────────────────────────────────────────
{
  const s = makeState()
  check('comment with no selection is refused', addComment(s, ALICE, 'x') === null)
  check('empty insert suggestion is refused', addSuggestion(s, ALICE, '') === null)
  check('empty review is empty', Object.keys(emptyReview('r').comments).length === 0)
}

console.log(`\n${failed ? 'FAILED' : 'ok'} — ${ran - failed}/${ran} checks passed`)
process.exit(failed ? 1 : 0)
