import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { server } from './msw/server';

// Testing Library's default `findBy*` budget is 1s, and one assertion lives close enough to it to
// lose on a loaded machine: ReauthModal's wrong-password mapping was reported as "flaky, passes in
// isolation" by three separate agents and then failed a gate run at 1329ms — inside a run where
// nineteen spec files execute while Docker rebuilds a Supabase stack beside them. Measured, not
// assumed: the same file passes in ~1.2s on a quiet machine.
//
// 3s, deliberately not 5s: vitest's own `testTimeout` is 5s, so a 5s await budget makes the test
// time out before the matcher can report what it did or did not find — which is how a first attempt
// at this turned a legible failure into an illegible one.
//
// No assertion is weakened. Every `findBy*` still requires its exact condition; this only stops a
// busy machine from being read as a product defect — the same lesson the PowerShell gates learned
// three times over: wait for the condition, never for a budget.
configure({ asyncUtilTimeout: 3_000 });

// AND `configure()` DOES NOT REACH `vi.waitFor`. It is vitest's own utility, it keeps a 1s
// default of its own, and on 28.08.2026 that default failed `webhookSettings.spec.tsx` twice in
// CI on a branch that does not import anything the file touches — the same picture DEBT §52
// records for testing-library's waits. There is no global setting for it, so every `vi.waitFor`
// in the suite carries `{ timeout: 3_000 }` explicitly. If a new one is added without it, it is
// running on a budget the rest of the suite decided was too small.

// `error` on purpose: a request the handlers do not describe is a test that is lying about what
// the app does. It must fail loudly rather than reach the network or hang.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
