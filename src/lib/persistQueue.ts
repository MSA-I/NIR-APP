/**
 * A coalescing write queue for a preference that the SCREEN changes instantly and the SERVER
 * records afterwards.
 *
 * Two controls in this product now change the same stored preference from two places — the
 * language `<select>` on /settings and the one in the account menu, and after the appearance work
 * the theme toggle and its own settings row. Without a coordinator above them, two quick changes
 * race: both writes leave together, they settle in whatever order the network decides, and the
 * screen ends up in one language while `profiles.locale` holds the other. The person sees the
 * right screen today and the wrong one tomorrow, which is the worst version of this bug because
 * nothing about it looks broken at the time.
 *
 * WHY A QUEUE AND NOT `await` (this was got wrong once, in planning, and it is worth writing down).
 * "Serialize the writes" sounds like the fix and is not: it makes the SECOND write wait for the
 * first, so a person who flips three times sits through three round trips and the two intermediate
 * values are written for no reason — nobody asked for them, they were passed through. What is
 * actually wanted is *last intent wins*: at most one write in flight, exactly one pending intent
 * behind it, and everything in between dropped.
 *
 *     submit(en) ─▶ write(en) ──────────────┐
 *     submit(fr)    (pending := fr)         │  fr is overwritten, never written
 *     submit(he)    (pending := he)         │
 *                                        settle ─▶ write(he)
 *
 * THE THREE FAILURE CASES ARE NOT THE SAME FAILURE, which is the other thing a naive
 * implementation gets wrong — it reports all of them:
 *
 *   · a write that FAILED but was already SUPERSEDED is not worth a word to anyone. The value it
 *     was carrying is not what the person wants any more; announcing it would report a problem
 *     with a choice they have already replaced.
 *   · a write that failed and is the LAST one is the real report — the screen changed and the
 *     account did not.
 *   · a write that settles after the owner changed (sign-out, or switching profile) is discarded
 *     whole: no report, and no follow-up write, because it belongs to somebody else's session.
 *
 * AND A FAILED WRITE CAN NEED NO REPAIR AT ALL. If `en` fails and the latest intent is back to the
 * value the server already holds, there is nothing to write: the queue compares against the last
 * value it knows to be persisted rather than firing on the way past. This is why `reset()` takes
 * the persisted value and not just the owner.
 *
 * The module is free of React and of Supabase on purpose — `persist` is injected — so the ordering
 * rules can be tested against the state machine itself rather than through a component.
 */

export interface PersistQueue<T> {
  /**
   * Record a new intent. Starts a write when nothing is in flight; otherwise it replaces whatever
   * intent was waiting. Never rejects, never throws: the caller has already updated the screen.
   */
  submit(value: T): void;
  /**
   * Point the queue at a different owner — sign-in, a profile change, sign-out (`null`).
   *
   * Anything already in flight is disowned rather than cancelled: the request is allowed to finish
   * (there is no abort path through PostgREST worth the complexity) but its result is ignored, so
   * it can neither report a failure into the new session nor trigger a follow-up write against it.
   */
  reset(owner: string | null, persisted: T | null): void;
  /**
   * Record that the server now holds `value`, WITHOUT touching anything else.
   *
   * This exists because `reset` was being used for it, and `reset` disowns in-flight work. The
   * caller learns the persisted value from a profile refetch, which happens *because* a write
   * succeeded — so the moment the queue is most likely to have a second write in the air is exactly
   * the moment the old code threw that write away. Separating "the owner changed" from "the stored
   * value changed" is the whole fix.
   */
  notePersisted(value: T): void;
  /** What the queue believes right now. Read by tests; also the honest answer for a debug panel. */
  snapshot(): { owner: string | null; inFlight: boolean; pending: T | null; persisted: T | null };
}

export function createPersistQueue<T>({
  persist,
  onTerminalFailure,
  isEqual = (a: T, b: T) => a === b,
}: {
  /** Resolves `true` when the value is stored. A rejection is treated exactly as `false`. */
  persist: (owner: string, value: T) => Promise<boolean>;
  /** Called only for a failed write that nothing has superseded. */
  onTerminalFailure: (value: T) => void;
  isEqual?: (a: T, b: T) => boolean;
}): PersistQueue<T> {
  let owner: string | null = null;
  let persisted: T | null = null;
  let pending: T | null = null;
  let inFlight = false;
  /** Bumped by `reset`, so a settling write can tell whether it still belongs to this session. */
  let generation = 0;

  const drain = () => {
    if (owner === null || pending === null) return;
    // Already stored — nothing to say to the server. This is the case a failed write reaches when
    // the person has changed their mind back to where they started.
    if (persisted !== null && isEqual(pending, persisted)) {
      pending = null;
      return;
    }
    const value = pending;
    const generationAtStart = generation;
    const ownerAtStart = owner;
    pending = null;
    inFlight = true;
    void persist(ownerAtStart, value).then(
      (stored) => settle(generationAtStart, value, stored),
      () => settle(generationAtStart, value, false),
    );
  };

  const settle = (generationAtStart: number, value: T, stored: boolean) => {
    if (generationAtStart !== generation) return; // disowned by reset() — not this session's result
    inFlight = false;
    if (stored) persisted = value;
    // Read BEFORE draining: `drain` clears `pending`, and whether this write was superseded is
    // precisely the question of whether something was waiting behind it.
    const superseded = pending !== null;
    if (!stored && !superseded) onTerminalFailure(value);
    drain();
  };

  return {
    submit(value) {
      if (owner === null) return; // signed out, or an operator with no tenant profile to save to
      pending = value;
      if (!inFlight) drain();
    },
    reset(nextOwner, nextPersisted) {
      generation += 1;
      owner = nextOwner;
      persisted = nextPersisted;
      pending = null;
      inFlight = false;
    },
    notePersisted(value) {
      persisted = value;
      // A pending intent that is now already stored has nothing left to do; `drain` would work this
      // out on its own, but only on its next turn, and until then `snapshot` would lie.
      if (pending !== null && isEqual(pending, value)) pending = null;
    },
    snapshot: () => ({ owner, inFlight, pending, persisted }),
  };
}
