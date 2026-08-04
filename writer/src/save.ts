// SPDX-License-Identifier: MIT
// Self-saving: the file writes itself back to disk with new contents.
//
// At boot — BEFORE the app touches the DOM — we deep-clone the document. On
// save we swap the clone's JSON block for the current model and serialize the
// clone back to a string: byte-identical shell, new document inside. TiddlyWiki
// pioneered the trick; bento proved it survives a compressed runtime.
//
// THE TRAP THAT EATS FILES
// The compressed shell's loader inflates the stylesheet into a live <style>
// before our code runs, and the editor renders the whole document into the DOM
// as contenteditable HTML. Serializing the live document would write both back
// as plaintext — so the next open would inflate the payload AGAIN and append
// another copy. Every save would grow the file, forever. Hence: everything the
// runtime injects carries data-tf-transient and is stripped on the way out, and
// scripts/shell-gate.mjs asserts two consecutive saves produce the same length.

import type { TiffinDoc } from './model.ts'

const DATA_BLOCK_ID = 'tiffin-doc'
const DATA_BLOCK_TYPE = 'application/tiffin+json'
const TRANSIENT_SELECTOR = '[data-tf-transient]'
// Split so the literal never appears in the bundle — the bundle is itself
// inline script inside a built file, and a literal close tag would end it.
const SCRIPT_CLOSE = '</scr' + 'ipt>'

interface FsWritable {
  write(data: string): Promise<void>
  close(): Promise<void>
}
interface FsFileHandle {
  name: string
  createWritable(): Promise<FsWritable>
}
interface FsPickerOptions {
  suggestedName?: string
  id?: string
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}

const picker = (): ((o: FsPickerOptions) => Promise<FsFileHandle>) | null => {
  const fn = (globalThis as Record<string, unknown>).showSaveFilePicker
  return typeof fn === 'function' ? (fn as (o: FsPickerOptions) => Promise<FsFileHandle>) : null
}

export const canWriteInPlace = (): boolean => picker() !== null

let pristine: Document | null = null
let handle: FsFileHandle | null = null

/** Call first thing at boot, before any DOM mutation. */
export function capturePristine(): void {
  pristine = document.cloneNode(true) as Document
}

/** The JSON text this file was loaded with, or null for a fresh shell. */
export function readEmbeddedDoc(): string | null {
  const text = document.getElementById(DATA_BLOCK_ID)?.textContent?.trim()
  return text || null
}

/**
 * Serialize `doc` into a full HTML file.
 *
 * Every `<` in the JSON becomes `<`, which is why the block can never
 * contain a close tag and terminate itself — the single most load-bearing line
 * in this module. The count check afterwards is belt and braces: if generated
 * output ever unbalanced the file, a silent corrupt save is the worst possible
 * failure mode, so we at least say so.
 */
export function serialize(doc: TiffinDoc): string {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  const clone = pristine.cloneNode(true) as Document

  for (const el of Array.from(clone.querySelectorAll(TRANSIENT_SELECTOR))) el.remove()

  let block = clone.getElementById(DATA_BLOCK_ID)
  if (!block) {
    block = clone.createElement('script')
    block.setAttribute('type', DATA_BLOCK_TYPE)
    block.id = DATA_BLOCK_ID
    clone.head.appendChild(block)
  }
  block.textContent = '\n' + JSON.stringify(doc).replace(/</g, '\\u003c') + '\n'

  const titleEl = clone.querySelector('title')
  if (titleEl) titleEl.textContent = `${doc.title} — Tiffin`

  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML
  if (html.split(SCRIPT_CLOSE).length !== clone.querySelectorAll('script').length + 1) {
    console.warn('tiffin: unexpected script-close count in serialized file — not saving a file we cannot trust')
    throw new Error('serialization produced unbalanced script tags')
  }
  return html
}

export function suggestedFileName(doc: TiffinDoc): string {
  const base =
    doc.title
      .trim()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'Untitled'
  return `${base}.tiffin.html`
}

function download(html: string, name: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export type SaveOutcome = 'in-place' | 'picked' | 'downloaded' | 'cancelled'

/**
 * Save. Reuses the file handle once we have one, so ⌘S is a genuine in-place
 * write with no dialog — the thing that makes this feel like an application
 * rather than a web page.
 */
export async function saveFile(doc: TiffinDoc, forcePicker = false): Promise<SaveOutcome> {
  const html = serialize(doc)
  const name = suggestedFileName(doc)
  const show = picker()

  if (!show) {
    download(html, name)
    return 'downloaded'
  }

  let target = handle
  let picked = false
  if (!target || forcePicker) {
    try {
      target = await show({
        suggestedName: name,
        id: 'tiffin-doc',
        types: [{ description: 'Tiffin document', accept: { 'text/html': ['.tiffin.html', '.html'] } }],
      })
      picked = true
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return 'cancelled'
      download(html, name)
      return 'downloaded'
    }
  }

  const writable = await target.createWritable()
  await writable.write(html)
  await writable.close()
  handle = target
  return picked ? 'picked' : 'in-place'
}

/** Adopt a handle obtained elsewhere (drag-drop, launch queue). */
export function adoptFileHandle(h: FsFileHandle): void {
  handle = h
}

export const currentFileName = (): string | null => handle?.name ?? null
export const hasFileHandle = (): boolean => handle !== null
