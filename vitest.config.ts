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
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      // `.spec` is vitest; `.test` stays with `node --test`. The one existing unit suite,
      // src/components/document-review/model.test.ts, imports from 'node:test' and is run by
      // `npm run check:review`. Two runners, two extensions, no collision and no migration.
      include: ['src/**/*.spec.{ts,tsx}'],
      restoreMocks: true,
      clearMocks: true,
      coverage: {
        provider: 'v8',
        include: ['src/lib/query/**', 'src/lib/useQuery.ts'],
        reporter: ['text-summary'],
      },
    },
  }),
);
