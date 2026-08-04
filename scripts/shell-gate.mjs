#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The conformance gate. Runs on every build, and a failure here is a build
// failure — because each of these checks corresponds to a way a shipped file
// gets bricked on someone else's disk, where we cannot fix it.
//
//   node scripts/shell-gate.mjs writer/dist-single/Tiffin_Writer.tiffin.html

import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/shell-gate.mjs <shell.html>')
  process.exit(1)
}
const html = readFileSync(path, 'utf8')

const results = []
const check = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail ?? '' })
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const DOC_RE = /(<script type="application\/tiffin\+json" id="tiffin-doc">)([\s\S]*?)(<\/script>)/

// ── 1. Zero external subresources ───────────────────────────────────────────
// A Tiffin file that fetches anything is not a Tiffin file: it stops working on
// a plane, behind a firewall, or the day the host goes away.
check('no external subresources', () => {
  const offenders = []
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = m[1]
    if (/^(?:https?:)?\/\//i.test(url)) offenders.push(url)
  }
  for (const m of html.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)) offenders.push(`@import ${m[1]}`)
  for (const m of html.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)/gi)) offenders.push(m[1])
  assert(offenders.length === 0, `external references: ${offenders.slice(0, 5).join(', ')}`)
  return 'nothing loads from the network'
})

// ── 2. The document block ───────────────────────────────────────────────────
check('#tiffin-doc is plaintext, present and parses', () => {
  const m = html.match(DOC_RE)
  assert(m, 'no #tiffin-doc block')
  const body = m[2].trim()
  assert(body.length > 0, 'document block is empty — a released file must carry a starter document')
  const doc = JSON.parse(body)
  assert(doc.format === 'tiffin/doc', `format is ${JSON.stringify(doc.format)}`)
  assert(typeof doc.version === 'number', 'no version')
  assert(doc.body && typeof doc.body === 'object', 'no body')
  assert(!body.includes('</scr' + 'ipt'), 'document block contains a script close tag')
  return `${(body.length / 1024).toFixed(1)} KB of readable JSON, format v${doc.version}`
})

check('document block precedes the runtime payloads', () => {
  const doc = html.indexOf('id="tiffin-doc"')
  const js = html.indexOf('id="tf-rt-js"')
  assert(doc > -1 && js > -1, 'missing a required block')
  assert(doc < js, 'the payload comes before the document — a reader has to stream the runtime first')
  return 'canonical byte order'
})

// ── 3. Script-tag balance ───────────────────────────────────────────────────
// The frozen splice contract depends on it: an unbalanced file cannot survive a
// parse → splice → serialize round-trip, and a naive text updater would corrupt
// it silently.
check('script tags balance', () => {
  const opens = (html.match(/<script\b/gi) ?? []).length
  const closes = (html.match(/<\/script\s*>/gi) ?? []).length
  assert(opens === closes, `${opens} open vs ${closes} close`)
  return `${opens} script elements, balanced`
})

// ── 4. The payloads are intact ──────────────────────────────────────────────
check('base64 payloads inflate', () => {
  const out = []
  for (const id of ['tf-rt-css', 'tf-rt-js']) {
    const m = html.match(new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`))
    assert(m, `missing payload ${id}`)
    const b64 = m[1].trim()
    assert(/^[A-Za-z0-9+/=]+$/.test(b64), `${id} is not clean base64`)
    const text = inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8')
    assert(text.length > 0, `${id} inflated to nothing`)
    out.push(`${id} ${(b64.length / 1024).toFixed(1)} KB → ${(text.length / 1024).toFixed(1)} KB`)
  }
  return out.join(', ')
})

// ── 5. The growth-on-save regression ────────────────────────────────────────
// The runtime inflates the stylesheet into a live <style> at boot. If the shell
// also carried that CSS as plaintext, or if the loader failed to mark what it
// injects as transient, every save would append another copy and the file would
// grow forever. Both halves of the defence are asserted statically here.
check('no plaintext stylesheet in the shell', () => {
  const styles = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? []
  assert(styles.length === 0, `${styles.length} inline <style> element(s) — the CSS must ship deflated`)
  return 'CSS ships compressed, exactly once'
})

check('loader marks injected DOM transient', () => {
  const loader = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)
  assert(loader, 'no loader script before </body>')
  const code = loader[1]
  assert(code.includes('data-tf-transient'), 'loader does not tag what it injects — saves would grow the file')
  const tags = (code.match(/setAttribute\(T,''\)/g) ?? []).length
  const created = (code.match(/document\.createElement/g) ?? []).length
  assert(tags >= created, `${created} nodes created, only ${tags} tagged transient`)
  return `${created} injected nodes, all tagged`
})

// ── 6. Survives the splice, twice, without drifting ─────────────────────────
// This is a v0.1.0-style TEXT splice on purpose: updaters embedded in files
// already on disk are frozen code, and this is the crudest thing one of them
// might do. If the file survives this, it survives a DOM round-trip too.
check('splice round-trip is idempotent', () => {
  const spliceIn = (src, json) =>
    src.replace(DOC_RE, (_m, open, _body, close) => open + '\n' + json.replace(/</g, '\\u003c') + '\n' + close)

  const original = JSON.parse(html.match(DOC_RE)[2].trim())
  const once = spliceIn(html, JSON.stringify(original))
  const twice = spliceIn(once, JSON.stringify(JSON.parse(once.match(DOC_RE)[2].trim())))

  assert(once === html, `first splice changed the file (${html.length} → ${once.length} bytes)`)
  assert(twice === once, `second splice drifted (${once.length} → ${twice.length} bytes)`)

  // And a real edit must not disturb anything but the block.
  const edited = spliceIn(html, JSON.stringify({ ...original, title: 'Round trip <test>' }))
  const parsed = JSON.parse(edited.match(DOC_RE)[2].trim())
  assert(parsed.title === 'Round trip <test>', 'edited title did not survive')
  assert(!edited.match(DOC_RE)[2].includes('<test>'), 'the < was not escaped on write')
  assert((edited.match(/<script\b/gi) ?? []).length === (html.match(/<script\b/gi) ?? []).length, 'splice changed tag count')
  return 'byte-stable across two splices, escaping holds'
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
const width = Math.max(...results.map((r) => r.name.length))
console.log(`\ngate: ${path}  (${(html.length / 1024).toFixed(1)} KB)\n`)
for (const r of results) {
  console.log(`  ${r.ok ? '[32mPASS[0m' : '[31mFAIL[0m'}  ${r.name.padEnd(width)}  ${r.detail}`)
}
console.log('')
if (failed.length) {
  console.error(`[31m${failed.length} of ${results.length} checks failed — not shippable.[0m\n`)
  process.exit(1)
}
console.log(`[32mall ${results.length} checks passed.[0m\n`)
