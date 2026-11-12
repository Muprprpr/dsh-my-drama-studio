import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const manifest = createRequire(import.meta.url)('../package.json')
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/host.js'], outfile: 'dist/host.js', bundle: true, format: 'esm', platform: 'node', packages: 'external' })
const { outputFiles } = await build({
  entryPoints: ['src/client.jsx'], outfile: 'dist/client.js', bundle: true, format: 'cjs',
  platform: 'browser', write: false, jsx: 'automatic',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text' },
})
const js = outputFiles.find(file => file.path.endsWith('.js')).text
await writeFile('dist/client.js', `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory(require) {
const module = { exports: {} }; const exports = module.exports;
${js}
return module.exports;
}});\n`)
