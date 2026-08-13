import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Merged rather than standalone: the tests render real components, so they need the same React
// and Tailwind plugins and the same chunking-free module resolution the app builds with. A
// separate config would silently diverge from the thing it claims to test.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      env: {
        // Unit tests must never depend on an ignored developer .env file. Components that do not
        // exercise Supabase still import the shared client, so give that client an inert local URL.
        VITE_SUPABASE_URL: 'http://127.0.0.1:55431',
        VITE_SUPABASE_ANON_KEY: 'vitest-local-anon-key',
      },
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      // One unit-test runner. Node-only business checks live beside the code as `.spec.ts` files;
      // browser, SQL and Edge integration contracts stay in their dedicated gates.
      include: ['src/**/*.spec.{ts,tsx}'],
      restoreMocks: true,
      clearMocks: true,
    },
  }),
);
