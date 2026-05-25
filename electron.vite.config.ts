import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv } from 'vite'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  // Load .env so OAuth client IDs are baked into the build output. Variables
  // without a prefix are loaded by passing '' as the third argument (loadEnv
  // defaults to filtering by VITE_).
  const env = loadEnv(mode, process.cwd(), '')

  const cloudDefines = {
    __GOOGLE_CLIENT_ID__:     JSON.stringify(env.GOOGLE_CLIENT_ID     ?? ''),
    __GOOGLE_CLIENT_SECRET__: JSON.stringify(env.GOOGLE_CLIENT_SECRET ?? ''),
    __DROPBOX_APP_KEY__:      JSON.stringify(env.DROPBOX_APP_KEY      ?? ''),
    __ONEDRIVE_CLIENT_ID__:   JSON.stringify(env.ONEDRIVE_CLIENT_ID   ?? ''),
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
      define: cloudDefines,
      build: {
        outDir: 'dist/main',
        rollupOptions: {
          input: { index: resolve('src/main/index.ts') }
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: 'dist/preload',
        rollupOptions: {
          input: { index: resolve('src/preload/index.ts') }
        }
      }
    },
    renderer: {
      root: 'src/renderer',
      build: {
        outDir: 'dist/renderer',
        rollupOptions: {
          input: { index: resolve('src/renderer/index.html') }
        }
      }
    }
  }
})
