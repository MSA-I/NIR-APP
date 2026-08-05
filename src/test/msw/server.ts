import { setupServer } from 'msw/node';
import { handlers } from './handlers';

// One server for the whole suite. `setup.ts` starts it with `onUnhandledRequest: 'error'`, so a
// test that reaches an undescribed endpoint fails instead of silently talking to the network.
export const server = setupServer(...handlers);
