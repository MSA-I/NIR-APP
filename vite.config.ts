import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    {
      name: 'supplyflow-font-mode',
      transformIndexHtml(html) {
        if (process.env.VITE_FONT_MODE !== 'almoni') return html;
        const faces = [400, 500, 600]
          .map((weight) => `@font-face{font-family:"Almoni Neue SupplyFlow";font-style:normal;font-weight:${weight};font-display:swap;src:url("/fonts/almoni/AlmoniNeue-${weight}.woff2") format("woff2")}`)
          .join('');
        const preloads = [400, 500, 600]
          .map((weight) => `<link rel="preload" href="/fonts/almoni/AlmoniNeue-${weight}.woff2" as="font" type="font/woff2" crossorigin />`)
          .join('\n    ');
        return html
          .replace('<html lang="he" dir="rtl">', '<html lang="he" dir="rtl" data-font-mode="almoni">')
          .replace('</head>', `    <style>${faces}</style>\n    ${preloads}\n  </head>`);
      },
    },
    react(),
    tailwindcss(),
    // App-shell precache (DEBT-REGISTER §2 / OPEN-DECISIONS #101, closed 09.08.2026).
    // injectManifest over the EXISTING public/sw.js: the plugin only replaces
    // self.__WB_MANIFEST in the built worker with the hashed asset list — the push handlers,
    // skipWaiting/clients.claim and therefore the controllerchange contract in src/main.tsx
    // are byte-for-byte the code we wrote, no workbox runtime. Registration stays manual
    // (injectRegister: false), so main.tsx remains the single registration site.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'public',
      filename: 'sw.js',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        // The shell, its HTML-declared resources and the everyday chunks. `recharts` is a
        // dependency of the entry chunk after Rollup's shared-chunk extraction, so excluding it
        // produces a cached HTML document that still cannot boot offline. Only the two genuinely
        // online-only document stacks stay out; once loaded they join the runtime cache below.
        //
        // The operator console (operator.html + its `operator` entry chunk) stays out of the
        // precache entirely: this worker is the TENANT shell's, and the console is an
        // online-only cross-tenant surface that must never be served from a tenant cache.
        // Note `navigateFallbackDenylist` does not exist in injectManifest mode — the
        // equivalent guard lives in public/sw.js, which refuses to answer /operator
        // navigations from the shell cache.
        // `ico` joined the list when index.html began linking /favicon.ico: the offline shell
        // check refuses cached HTML that depends on a resource the worker never cached.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        // The supplier portal (portal.html + its `portal` entry chunk) stays out for the same
        // reason as the operator console: it is not the tenant shell, and a token-bearing
        // supplier page must never be served from a tenant cache.
        globIgnores: ['**/assets/PdfSourceView-*.js', '**/assets/xlsx-*.js', '**/operator.html', '**/assets/operator-*', '**/portal.html', '**/assets/portal-*'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      // The dev server serves public/sw.js verbatim (self.__WB_MANIFEST undefined → the
      // worker's `|| []` guard makes dev behave exactly like before: push only, no cache).
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5199, allowedHosts: true },
  preview: { allowedHosts: true },
  build: {
    rollupOptions: {
      // Two applications, one deploy: the tenant SPA and the operator console are separate HTML
      // entries in the same dist, so the console ships with the same release ritual and the same
      // env while the TENANT bundle carries zero operator code. The tenant key is deliberately
      // `index` (not `main`): the input alias names the entry chunk, and renaming the tenant
      // bundle from assets/index-*.js to assets/main-*.js would be a gratuitous change in a
      // commit that is about the operator, not the tenant.
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        operator: fileURLToPath(new URL('./operator.html', import.meta.url)),
        // Third entry: the no-login supplier order portal. Same deploy, zero tenant code paths
        // in its chunk, and the tenant bundle carries zero portal code.
        portal: fileURLToPath(new URL('./portal.html', import.meta.url)),
      },
      output: {
        // Split the charting stack into its own chunk. recharts v2 pulls its d3 code
        // through victory-vendor (+ internmap), so only Dashboard/Reports load it — the
        // rest of the app (and supplier/payer roles) never pays for it up front.
        manualChunks(id) {
          if (
            id.includes('node_modules/recharts') ||
            id.includes('node_modules/victory-vendor') ||
            id.includes('node_modules/d3-') ||
            id.includes('node_modules/internmap')
          ) {
            return 'recharts';
          }
          // Same reasoning for the barcode reader (wave 8): @zxing/library is ~17MB unpacked and
          // is reached only through a dynamic import behind the `receiving.barcode` flag. Naming
          // the chunk keeps it out of the entry graph even if a static import ever creeps in.
          if (
            id.includes('node_modules/@zxing/') ||
            id.includes('node_modules/ts-custom-error')
          ) {
            return 'barcode';
          }
        },
      },
    },
  },
});
