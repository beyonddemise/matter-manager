import { defineConfig } from 'vite'

export default defineConfig({
  // import.meta.dirname (not __dirname): this package is "type": "module", and under
  // NodeNext module resolution __dirname does not exist in real ESM. import.meta.dirname
  // is the direct equivalent, available since Node 20.11 and always present given this
  // repo's node >=22 engine requirement.
  root: import.meta.dirname,
  build: { outDir: 'dist', emptyOutDir: true },
})
