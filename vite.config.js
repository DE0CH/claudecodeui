import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

/**
 * Jarvis staff mode (VITE_JARVIS=true, see src/shared/jarvis.ts): the page's own branding (title, icons,
 * manifest, language) carries the product name instead of CloudCLI's.
 */
function jarvisBranding(env) {
  const enabled = env.VITE_JARVIS === 'true'
  const name = env.VITE_PRODUCT_NAME || 'YYC AI'
  const manifest = JSON.stringify({
    name,
    short_name: name,
    description: name,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    orientation: 'portrait-primary',
    scope: '/',
    icons: [
      { src: '/icons/jarvis-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/jarvis-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  }, null, 2)
  const escapeHtml = (value) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  return {
    name: 'jarvis-branding',
    transformIndexHtml(html) {
      if (!enabled) return html
      return html
        .replace('<html lang="en">', '<html lang="zh-HK">')
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(name)}</title>`)
        .replace(/content="Claude UI"/, `content="${escapeHtml(name)}"`)
        .replace('href="/favicon.svg"', 'href="/icons/jarvis-favicon.svg"')
        .replace('href="/favicon.png"', 'href="/icons/jarvis-favicon.png"')
        .replace('href="/manifest.json"', 'href="/icons/jarvis-manifest.json"')
        .replace(/<link rel="apple-touch-icon" sizes="152x152"[^>]*>/, '')
        .replace(/<link rel="apple-touch-icon" sizes="180x180" href="[^"]*"/, '<link rel="apple-touch-icon" sizes="180x180" href="/icons/jarvis-icon-180.png"')
    },
    configureServer(server) {
      if (!enabled) return
      server.middlewares.use('/icons/jarvis-manifest.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json')
        res.end(manifest)
      })
    },
    generateBundle() {
      if (!enabled) return
      this.emitFile({ type: 'asset', fileName: 'icons/jarvis-manifest.json', source: manifest })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [react(), jarvisBranding(env)],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
