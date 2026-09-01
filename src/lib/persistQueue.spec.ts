/**
 * The ordering rules, tested against the state machine rather than through a component.
 *
 * Every test here drives `persist` with a DEFERRED promise it resolves by hand, because the whole
 * subject is what happens in the window between "the write left" and "the write came back". A test
 * that let the promises settle on their own would be asserting on the scheduler.
 *
 * The oracle that was wrong first time round, kept here as a comment because it is the trap:
 * "the second call always starts after the first settles" is NOT a general truth. It holds when
 * the first write succeeds. When the first write FAILS and the latest intent is back at the value
 * the server already holds, the correct behaviour is that there is no second call at all — see
 * `no second write when the intent is already stored`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPersistQueue } from './persistQueue';

type Deferred = { resolve: (stored: boolean) => void; reject: (reason?: unknown) => void };

/** A `persist` that hands back control of each call's promise, in call order. */
function controllable() {
  const calls: { owner: string; value: string }[] = [];
  const deferreds: Deferred[] = [];
  const persist = (owner: string, value: string) => {
    calls.push({ owner, value });
    return new Promise<boolean>((resolve, reject) => {
      deferreds.push({ resolve, reject });
    });
  };
  return { calls, deferreds, persist };
}

/** Lets the queue's own `.then` handlers run. */
const flush = () => Promise.resolve().then(() => undefined);

describe('createPersistQueue', () => {
  it('writes nothing while there is no owner', () => {
    const { calls, persist } = controllable();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure: vi.fn() });

    queue.submit('en');

    expect(calls).toEqual([]);
  });

  it('success-first: coalesces to the last intent and reports nothing', async () => {
    const { calls, deferreds, persist } = controllable();
    const onTerminalFailure = vi.fn();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure });
    queue.reset('profile-1', 'he');

    // he → en → he. The intermediate `fr` is here to prove intents are replaced, not enqueued.
    queue.submit('en');
    queue.submit('fr');
    queue.submit('he');

    // ONE call so far: the second intent must wait behind the first write.
    expect(calls).toEqual([{ owner: 'profile-1', value: 'en' }]);
    expect(queue.snapshot().pending).toBe('he');

    deferreds[0].resolve(true);
    await flush();

    // Now the last intent goes, and `fr` never does.
    expect(calls).toEqual([
      { owner: 'profile-1', value: 'en' },
      { owner: 'profile-1', value: 'he' },
    ]);

    deferreds[1].resolve(true);
    await flush();

    expect(queue.snapshot()).toEqual({ owner: 'profile-1', inFlight: false, pending: null, persisted: 'he' });
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it('stale-failure: a superseded write that fails reports nothing and still hands over', async () => {
    const { calls, deferreds, persist } = controllable();
    const onTerminalFailure = vi.fn();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    queue.submit('fr'); // supersedes `en`, and is NOT the value the server already holds

    deferreds[0].resolve(false); // `en` failed — but nobody wants `en` any more
    await flush();

    expect(onTerminalFailure).not.toHaveBeenCalled();
    expect(calls[1]).toEqual({ owner: 'profile-1', value: 'fr' });
  });

  it('terminal-failure: the last write failing is reported, with the value the person chose', async () => {
    const { deferreds, persist } = controllable();
    const onTerminalFailure = vi.fn();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    queue.submit('fr');

    deferreds[0].resolve(false);
    await flush();
    deferreds[1].resolve(false);
    await flush();

    // Reported once, for `fr` — the final intent — and not for the superseded `en`.
    expect(onTerminalFailure.mock.calls).toEqual([['fr']]);
    // A failed write must not be recorded as persisted, or a later retry would be skipped.
    expect(queue.snapshot().persisted).toBe('he');
  });

  it('a rejected promise is treated exactly as a refused write', async () => {
    const { deferreds, persist } = controllable();
    const onTerminalFailure = vi.fn();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    deferreds[0].reject(new Error('network'));
    await flush();

    expect(onTerminalFailure.mock.calls).toEqual([['en']]);
  });

  it('no second write when the intent is already stored', async () => {
    const { calls, deferreds, persist } = controllable();
    const onTerminalFailure = vi.fn();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    queue.submit('he'); // straight back to what the server already holds

    deferreds[0].resolve(false); // `en` failed, so `he` is still the stored value
    await flush();

    // Nothing to repair: one call, ever.
    expect(calls).toHaveLength(1);
    expect(queue.snapshot()).toEqual({ owner: 'profile-1', inFlight: false, pending: null, persisted: 'he' });
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it('submitting the stored value writes nothing at all', () => {
    const { calls, persist } = controllable();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure: vi.fn() });
    queue.reset('profile-1', 'he');

    queue.submit('he');

    expect(calls).toEqual([]);
  });

  it('reset disowns an in-flight write: no report, no follow-up, no leak into the next session', async () => {
    const { calls, deferreds, persist } = controllable();
    const onTerminalFailure = vi.fn();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    queue.submit('fr');           // something is waiting behind the in-flight write
    queue.reset('profile-2', 'he'); // sign-out and back in as somebody else

    deferreds[0].resolve(false); // profile-1's write comes back late
    await flush();

    expect(onTerminalFailure).not.toHaveBeenCalled();  // not this session's problem
    expect(calls).toHaveLength(1);                     // `fr` belonged to profile-1 and is gone
    expect(queue.snapshot()).toEqual({ owner: 'profile-2', inFlight: false, pending: null, persisted: 'he' });
  });

  it('reset to signed-out drops the queue and accepts nothing further', async () => {
    const { calls, deferreds, persist } = controllable();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure: vi.fn() });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    queue.reset(null, null);
    deferreds[0].resolve(true);
    await flush();

    queue.submit('fr');

    expect(calls).toHaveLength(1);
    expect(queue.snapshot().owner).toBeNull();
  });

  /**
   * THE REGRESSION TEST FOR THE BUG THIS API EXISTS TO FIX.
   *
   * `notePersisted` was added because callers were using `reset` for it, and `reset` disowns work in
   * flight. The caller learns a new persisted value from a profile refetch, which happens BECAUSE a
   * write succeeded — so the one moment a second write is most likely to be in the air was exactly
   * the moment the old wiring threw it away. Screen on Hebrew, account on English, nothing logged.
   */
  it('notePersisted records the server value WITHOUT disowning work in flight', async () => {
    const { calls, deferreds, persist } = controllable();
    const onTerminalFailure = vi.fn();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure });
    queue.reset('profile-1', 'he');

    queue.submit('en');            // write leaves
    queue.submit('he');            // and 'he' waits behind it

    // The profile refetch lands while 'he' is still pending — this is the exact moment that used to
    // destroy it.
    queue.notePersisted('en');

    expect(queue.snapshot().owner).toBe('profile-1');
    expect(queue.snapshot().pending).toBe('he');

    deferreds[0].resolve(true);
    await flush();

    // 'he' still goes.
    expect(calls).toEqual([
      { owner: 'profile-1', value: 'en' },
      { owner: 'profile-1', value: 'he' },
    ]);
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it('notePersisted drops a pending intent that the server already holds', () => {
    const { calls, persist } = controllable();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure: vi.fn() });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    queue.submit('he');
    // Somebody else (another tab, an admin) set it to 'he'. There is nothing left to write.
    queue.notePersisted('he');

    expect(queue.snapshot().pending).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('after a terminal failure the same value can be retried', async () => {
    const { calls, deferreds, persist } = controllable();
    const queue = createPersistQueue<string>({ persist, onTerminalFailure: vi.fn() });
    queue.reset('profile-1', 'he');

    queue.submit('en');
    deferreds[0].resolve(false);
    await flush();

    queue.submit('en'); // the person presses it again, which is what people do

    expect(calls).toEqual([
      { owner: 'profile-1', value: 'en' },
      { owner: 'profile-1', value: 'en' },
    ]);
  });
});
