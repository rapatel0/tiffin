// SPDX-License-Identifier: MIT
// Boot. Order matters more here than anywhere else in the app.

import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './styles.css'

import { capturePristine, canWriteInPlace, currentFileName, readEmbeddedDoc, saveFile, serialize } from './save.ts'
import {
  defaultPageSetup,
  docContentKey,
  newAnnotationId,
  newDocId,
  parseDoc,
  FORMAT,
  VERSION,
  type TiffinDoc,
} from './model.ts'
import { Writer } from './editor.ts'
import { buildChrome, columnOf, mainOf } from './toolbar.ts'
import { buildPanel } from './panel.ts'
import { mergeReview, pickColor, purgeReview, type Author } from './review.ts'
import starter from './starter.json'

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRISTINE FIRST. Before a single DOM mutation, snapshot the shell exactly as
// it came off disk. Everything the app injects from here on is marked transient
// and stripped at save time; this clone is what a saved file is made of.
// ─────────────────────────────────────────────────────────────────────────────
capturePristine()

function loadDocument(): TiffinDoc {
  const raw = readEmbeddedDoc()
  if (raw) {
    try {
      return parseDoc(raw)
    } catch (err) {
      // A corrupt block must not cost the user their file. Refuse to boot rather
      // than open an empty editor over the top of their document and let a save
      // overwrite it with nothing.
      document.body.innerHTML = ''
      const msg = document.createElement('pre')
      msg.style.cssText = 'padding:32px;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;color:#b00'
      msg.textContent =
        `Tiffin could not read the document in this file:\n\n  ${(err as Error).message}\n\n` +
        `The document JSON is the #tiffin-doc block near the top of this file — ` +
        `open it in a text editor to repair it. Nothing has been modified.`
      document.body.appendChild(msg)
      throw err
    }
  }
  // Fresh shell: the starter document, with its own identity minted now.
  return { ...(starter as unknown as TiffinDoc), docId: newDocId(), modified: new Date().toISOString() }
}

const doc = loadDocument()

// ─────────────────────────────────────────────────────────────────────────────
// 2. Chrome, then editor. One transient root holds all of it.
// ─────────────────────────────────────────────────────────────────────────────
let dirty = false
let savedKey = ''

const setDirty = (d: boolean) => {
  dirty = d
  chrome.setDirty(d)
}

const writer = new Writer(document.createElement('div'), doc, {
  onChange: () => {
    const key = docContentKey(writer.snapshot())
    setDirty(key !== savedKey)
  },
  onPages: (pages) => chrome.setPages(pages),
  onReview: () => panel.render(),
})

const chrome = buildChrome(writer, {
  save: () => void doSave(false),
  saveAs: () => void doSave(true),
  print: () => window.print(),
  copyJson: () => void copyJson(),
  replaceJson: () => void replaceJson(),
  toggleReview: () => chrome.setReviewOpen(panel.toggle()),
})

// ─────────────────────────────────────────────────────────────────────────────
// Identity. There is no server to authenticate against, so a reviewer is a name
// they chose, remembered per-document. A claim, not a credential — the format
// says so out loud rather than implying otherwise with an avatar.
// ─────────────────────────────────────────────────────────────────────────────
const IDENTITY_KEY = `tiffin:me:${doc.docId}`

function author(): Author {
  let raw = ''
  try {
    raw = localStorage.getItem(IDENTITY_KEY) ?? ''
  } catch {
    /* private mode, or a file:// origin with storage disabled */
  }
  if (raw) {
    try {
      return JSON.parse(raw) as Author
    } catch {
      /* fall through and mint a new one */
    }
  }
  const name = window.prompt('Your name, for comments on this document:')?.trim() || 'Anonymous'
  const me: Author = {
    id: newAnnotationId('p'),
    person: { name, color: pickColor(writer.review.people) },
  }
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(me))
  } catch {
    /* not fatal: the name just will not persist to the next open */
  }
  return me
}

const panel = buildPanel(writer, {
  author,
  importReview: () => void importReview(),
  purge: () => {
    const { review, removed } = purgeReview(writer.review)
    if (!removed) return note('Nothing to purge — no resolved comments or settled suggestions.')
    writer.setReviewData(review)
    note(`Purged ${removed} settled item${removed === 1 ? '' : 's'}.`)
  },
  note: (text, isError) => note(text, isError),
})

document.body.appendChild(chrome.root)
// Re-home the editor into the page column now that the chrome exists. Building
// the view against a detached node first keeps the paginator from measuring a
// layout that has no width.
columnOf(chrome.root).appendChild(writer.view.dom)
mainOf(chrome.root).appendChild(panel.root)

writer.applyGeometry()
document.title = `${writer.title} — Tiffin`
savedKey = docContentKey(writer.snapshot())
setDirty(false)

document.getElementById('tf-splash')?.classList.add('done')
writer.focus()

// ─────────────────────────────────────────────────────────────────────────────
// 3. File actions
// ─────────────────────────────────────────────────────────────────────────────
async function doSave(forcePicker: boolean): Promise<void> {
  const snapshot = writer.snapshot()
  try {
    const outcome = await saveFile(snapshot, forcePicker)
    if (outcome === 'cancelled') return
    savedKey = docContentKey(snapshot)
    setDirty(false)
    if (outcome === 'downloaded' && !canWriteInPlace()) {
      note('Downloaded. This browser has no File System Access API, so every save is a new download.')
    } else {
      note(`Saved${currentFileName() ? ` to ${currentFileName()}` : ''}`)
    }
  } catch (err) {
    note(`Save failed: ${(err as Error).message}`, true)
  }
}

async function copyJson(): Promise<void> {
  const json = JSON.stringify(writer.snapshot(), null, 2)
  try {
    await navigator.clipboard.writeText(json)
    note('Document JSON copied — paste it to an assistant, then use Paste JSON.')
  } catch {
    // Clipboard needs a permission this context may not have. Fall back to a
    // selectable textarea rather than losing the user's intent.
    const ta = document.createElement('textarea')
    ta.value = json
    ta.setAttribute('data-tf-transient', '')
    ta.style.cssText = 'position:fixed;inset:auto 12px 12px auto;width:40ch;height:12em;z-index:20'
    document.body.appendChild(ta)
    ta.select()
    note('Clipboard blocked — the JSON is selected in the box; copy it manually.')
    ta.addEventListener('blur', () => ta.remove())
  }
}

/**
 * Merge another copy's review into this one.
 *
 * The whole async-review design rests on one precondition: both copies describe
 * the same prose. `baseRev` is how that gets checked, and a mismatch is refused
 * loudly rather than merged optimistically — positions from a different body
 * point at text that is not there, and the result would be annotations quietly
 * attached to the wrong sentences.
 */
async function importReview(): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.html,.tiffin.html,text/html'
  input.setAttribute('data-tf-transient', '')
  const picked = new Promise<File | null>((resolve) => {
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
  })
  input.click()
  const file = await picked
  if (!file) return

  try {
    const html = await file.text()
    const block = new DOMParser().parseFromString(html, 'text/html').getElementById('tiffin-doc')
    if (!block?.textContent) throw new Error('no Tiffin document block in that file')
    const theirs = parseDoc(block.textContent)

    const incoming = theirs.review
      ? Object.keys(theirs.review.comments).length + Object.keys(theirs.review.suggestions).length
      : 0
    if (!theirs.review || !incoming) {
      return note(`${file.name} has no comments or suggestions to import.`)
    }
    if (theirs.docId !== writer.snapshot().docId) {
      return note(`${file.name} is a different document, not a copy of this one.`, true)
    }
    const mineRev = writer.currentRev()
    if (theirs.review.baseRev !== mineRev) {
      return note(
        `${file.name} was edited, not just annotated — its positions describe different prose, ` +
          `so it cannot be merged automatically.`,
        true,
      )
    }

    const { review, report } = mergeReview(writer.review, theirs.review)
    const added = report.comments + report.suggestions
    writer.setReviewData(review)
    panel.render()
    note(
      added
        ? `Merged ${report.comments} comment${report.comments === 1 ? '' : 's'} and ` +
            `${report.suggestions} suggestion${report.suggestions === 1 ? '' : 's'} from ${file.name}.`
        : `Nothing new in ${file.name} — you already have all of it.`,
    )
  } catch (err) {
    note(`Could not import: ${(err as Error).message}`, true)
  }
}

async function replaceJson(): Promise<void> {
  const input = window.prompt('Paste tiffin/doc JSON to replace this document:')
  if (!input) return
  try {
    writer.loadDoc(parseDoc(input))
    setDirty(true)
    note('Document replaced — ⌘Z undoes it.')
  } catch (err) {
    note(`Not loaded: ${(err as Error).message}`, true)
  }
}

let noteTimer = 0
function note(text: string, isError = false): void {
  let el = document.getElementById('tf-note')
  if (!el) {
    el = document.createElement('div')
    el.id = 'tf-note'
    el.setAttribute('data-tf-transient', '')
    el.style.cssText =
      'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:30;' +
      'padding:8px 14px;border-radius:8px;font:500 12px/1.4 system-ui,sans-serif;' +
      'background:#16181d;color:#fff;box-shadow:0 6px 20px rgb(0 0 0 / .3);max-width:60ch'
    document.body.appendChild(el)
  }
  el.textContent = text
  el.style.background = isError ? '#8c1d18' : '#16181d'
  clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => el?.remove(), 4200)
}

// ⌘S has to work from anywhere in the app, not only when the prose has focus,
// so it is a window handler rather than a ProseMirror keymap entry.
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  if (e.key.toLowerCase() === 's') {
    e.preventDefault()
    void doSave(e.shiftKey)
  }
})

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return
  e.preventDefault()
  e.returnValue = ''
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. The agent surface. The document JSON is the interchange unit — a chat model
// cannot emit a multi-megabyte file, but it can rewrite this.
// ─────────────────────────────────────────────────────────────────────────────
declare global {
  interface Window {
    tiffin: {
      readonly doc: TiffinDoc
      readonly format: string
      readonly version: number
      readonly appVersion: string
      serialize(): string
      /** The whole .tiffin.html file as a string — what a save would write. */
      serializeFile(): string
      loadDoc(json: string | TiffinDoc): void
      save(): Promise<void>
      renderStatic(): HTMLElement
      /** Comments and suggestions, with anchors as of right now. */
      readonly review: TiffinDoc['review']
      /** Hash of the current prose — the merge precondition. */
      baseRev(): string
    }
  }
}

window.tiffin = {
  get doc() {
    return writer.snapshot()
  },
  format: FORMAT,
  version: VERSION,
  appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
  serialize: () => JSON.stringify(writer.snapshot(), null, 2),
  // Exposed so the save path is testable without a file picker: a harness can
  // serialize, reload the result, serialize again and assert the file did not
  // grow. That regression is invisible to every static check.
  serializeFile: () => serialize(writer.snapshot()),
  loadDoc: (json) => {
    writer.loadDoc(typeof json === 'string' ? parseDoc(json) : parseDoc(JSON.stringify(json)))
    setDirty(true)
  },
  save: () => doSave(false),
  renderStatic: () => writer.renderStatic(),
  get review() {
    return writer.snapshot().review
  },
  baseRev: () => writer.currentRev(),
}

// Keep the default page setup reachable for tooling that builds a doc from
// scratch against this build's defaults.
Object.defineProperty(window.tiffin, 'defaultPageSetup', { value: defaultPageSetup, enumerable: false })
