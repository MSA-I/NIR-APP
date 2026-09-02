import assert from 'node:assert/strict';
import { test } from 'vitest';
import { carriesAuthCallback, readAuthFragment } from './authFragment';

test('an auth callback fragment is recognised, everything else is left alone', () => {
  const tokens = readAuthFragment('#access_token=eyJ.a.b&refresh_token=r1&token_type=bearer&type=recovery');
  assert.equal(carriesAuthCallback(tokens), true);
  assert.equal(tokens.get('type'), 'recovery');
  assert.equal(tokens.has('access_token'), true);

  // A consumed or expired link carries an error, not tokens — still an auth callback.
  assert.equal(carriesAuthCallback(readAuthFragment('#error=access_denied&error_code=otp_expired')), true);

  // The supplier portal's own token and in-app hash state are not auth callbacks.
  assert.equal(carriesAuthCallback(readAuthFragment('#token=0123abcd')), false);
  assert.equal(carriesAuthCallback(readAuthFragment('#tab=payments')), false);
  assert.equal(carriesAuthCallback(readAuthFragment('')), false);
  assert.equal(readAuthFragment('').has('access_token'), false);
});
