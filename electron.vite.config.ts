import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  main: {
    // Keep node dependencies out of the bundle and load them from node_modules at
    // runtime. chokidar pulls in the native `fsevents` binding on macOS, and
    // bundling it breaks the binding (its `constants` come back undefined, so the
    // watcher throws before it ever starts) — which silently disabled *all* live
    // file/session watching in built apps while dev mode, where deps aren't
    // bundled, kept working.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Baked in at build time rather than fetched over IPC: the renderer shows this
    // in Settings, and `app.getVersion()` is main-only. Both come from the same
    // package.json the installer versions its artifacts from, so what Settings
    // reports is what was built.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
