import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
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
        // The shell and the everyday chunks. The three giant online-only stacks are left
        // out of the PRECACHE (a fresh deploy should not push ~1.4MB of charts/PDF/XLSX to
        // every phone); once loaded online they are runtime-cached by the worker, so a
        // previously visited screen still opens offline.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        globIgnores: ['**/assets/recharts-*.js', '**/assets/PdfSourceView-*.js', '**/assets/xlsx-*.js'],
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
