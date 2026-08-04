import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// base './' so a built file opens from file:// as happily as from a static host.
// SINGLEFILE=1 → JS, CSS and assets all inlined: that one file IS the document.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [...(process.env.SINGLEFILE ? [viteSingleFile()] : [])],
  build: {
    // A Tiffin file must issue zero network requests. Inline everything.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
    target: 'es2022',
  },
})
