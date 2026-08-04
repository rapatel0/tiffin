#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Self-extracting shell: compress the built runtime so the file on disk is
// roughly a third the size, with zero feature loss.
//
//   node scripts/postbuild-compress.mjs writer/dist-single/Tiffin_Writer.tiffin.html
//
// Takes the vite single-file build, pulls out the big inline module script and
// stylesheet, deflates them (raw) into base64 payload blocks, and rebuilds the
// document in a canonical byte order:
//
//   head chrome → tooling comment → #tiffin-doc (PLAINTEXT, always)
//   → splash (paints while the payload inflates) → payloads + loader last
//
// The loader inflates via the native DecompressionStream and boots the module
// from a blob URL.
//
// THE CONTRACT THIS MUST NOT BREAK (see docs/VISION.md invariants 1–2):
//   - #tiffin-doc stays plaintext, same id, outside the payloads, forever.
//   - No literal "</script>" anywhere outside a real script element. The base64
//     alphabet cannot produce one; the loader is written to avoid one.
//   - The whole file survives DOMParser → splice → outerHTML round-trips.
// scripts/shell-gate.mjs asserts all of it on every build.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/postbuild-compress.mjs <shell.html>')
  process.exit(1)
}

const html = readFileSync(path, 'utf8')
if (html.includes('id="tf-rt-js"')) {
  console.log('already compressed — skipping')
  process.exit(0)
}

// --- extract the runtime pieces ---------------------------------------------
const mod = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)
if (!mod) throw new Error('inline module script not found — was SINGLEFILE=1 set?')

const headEnd = html.indexOf('</head>')
const styleM = html.slice(0, headEnd).match(/<style[^>]*>([\s\S]*?)<\/style>/)
if (!styleM) throw new Error('app stylesheet not found in head')

const b64 = (s) => deflateRawSync(Buffer.from(s, 'utf8'), { level: 9 }).toString('base64')
const jsB64 = b64(mod[1])
const cssB64 = b64(styleM[1])

// --- the parts we carry forward verbatim ------------------------------------
const pick = (re, what) => {
  const m = html.match(re)
  if (!m) throw new Error(`${what} not found`)
  return m[0]
}
const title = pick(/<title>[\s\S]*?<\/title>/, '<title>')
// Tolerant of attribute order and of the source being formatted across lines —
// how index.html is indented must never be able to break a release.
const favicon = pick(/<link\b[^>]*rel=["']icon["'][^>]*>/, 'favicon link')
const tooling = pick(/<!--\s*[═\s]*\n?\s*AI AGENTS[\s\S]*?-->/, 'agent tooling comment')
const splash = pick(/<div id="tf-splash"[\s\S]*?<\/div>/, 'splash')

// The document block: keep whatever the build produced, and if it is empty fill
// it with the starter document so a released file is view-source honest the
// first time someone opens it.
let docBody = (html.match(/<script type="application\/tiffin\+json" id="tiffin-doc">([\s\S]*?)<\/script>/) ?? [
  null,
  '',
])[1].trim()
if (!docBody) {
  const starterPath = resolve(here, '../writer/src/starter.json')
  if (!existsSync(starterPath)) throw new Error(`starter document missing at ${starterPath}`)
  docBody = JSON.stringify(JSON.parse(readFileSync(starterPath, 'utf8')))
  console.log('injected starter document from writer/src/starter.json')
}
// Same <-escape the runtime applies on every save. A document block that could
// contain "</script>" would let a single apostrophe brick the file.
const docBlock =
  '<script type="application/tiffin+json" id="tiffin-doc">\n' + docBody.replace(/</g, '\\u003c') + '\n</script>'

// --- the loader --------------------------------------------------------------
// Written as one flat string on purpose: it must stay small, must contain no
// literal close tag, and must not depend on anything the payloads define.
// Injected DOM is marked data-tf-transient so save.ts strips it — otherwise the
// inflated CSS would be written back as plaintext and the file would grow by
// ~40 KB on every single save.
const LOADER = `(function(){
var T='data-tf-transient';
function inflate(id){
var t=document.getElementById(id).textContent.trim();
var raw=atob(t),n=raw.length,b=new Uint8Array(n);
for(var i=0;i<n;i++)b[i]=raw.charCodeAt(i);
return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
}
function fail(m){
var d=document.getElementById('tf-splash');
if(d)d.textContent=m;
}
if(typeof DecompressionStream!=='function'){
fail('This browser is too old to open a Tiffin file. Chrome 103+, Edge 103+, Safari 16.4+ or Firefox 113+ will work. Your document is safe: it is the JSON near the top of this file.');
return;
}
Promise.all([inflate('tf-rt-css'),inflate('tf-rt-js')]).then(function(r){
var st=document.createElement('style');
st.setAttribute(T,'');
st.textContent=r[0];
document.head.appendChild(st);
var s=document.createElement('script');
s.type='module';
s.setAttribute(T,'');
s.src=URL.createObjectURL(new Blob([r[1]],{type:'text/javascript'}));
document.head.appendChild(s);
}).catch(function(e){
fail('Tiffin could not unpack its runtime: '+e.message);
});
})()`

if (LOADER.includes('</scr' + 'ipt')) throw new Error('loader contains a script close tag')

// --- reassemble --------------------------------------------------------------
const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${title}
${favicon}
${tooling}
${docBlock}
</head>
<body>
${splash}
<script type="text/plain" id="tf-rt-css">${cssB64}</script>
<script type="text/plain" id="tf-rt-js">${jsB64}</script>
<script>${LOADER}</script>
</body>
</html>
`

writeFileSync(path, out, 'utf8')

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
console.log(`compressed ${path}`)
console.log(`  runtime js   ${kb(mod[1].length)} → ${kb(jsB64.length)} base64`)
console.log(`  stylesheet   ${kb(styleM[1].length)} → ${kb(cssB64.length)} base64`)
console.log(`  document     ${kb(docBody.length)} plaintext`)
console.log(`  FILE         ${kb(html.length)} → ${kb(out.length)}`)
