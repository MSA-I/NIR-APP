import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
