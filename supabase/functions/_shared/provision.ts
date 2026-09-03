/**
 * Tenant provisioning, extracted so the two doors that create an organization run the SAME code.
 *
 * There are exactly two: `admin-provision`, where a platform operator creates a customer, and
 * `public-signup`, where an anonymous visitor does (0159). They differ in who is allowed to
 * knock and in whether the owner's email starts confirmed — nothing else. A second copy of "create
 * an organization, an auth user, a profile and baseline categories, and unwind all of it when a
 * step fails" is how the two paths would quietly drift until one of them forgot the rollback.
 *
 * The rollback is explicit because it has to be: Postgres cannot roll back an `auth.users` insert
 * together with a public-schema transaction, since the admin API is a separate HTTP call. So the
 * work is unwound in reverse order of creation, and whatever could not be undone is REPORTED
 * rather than swallowed — a half-provisioned tenant that nobody hears about is worse than a loud
 * failure.
 *
 * THAT SENTENCE WAS TRUE ABOUT THE INTENT AND FALSE ABOUT THE CODE until 03.09.2026, twice over:
 * the unwind could not remove the organization at all, and it reported nothing when it failed to.
 * The full measurement is above `rollbackTenant`. The rule that came out of it is short enough to
 * state here: **a rollback reports what it MEASURED, never what it attempted.**
 */

/**
 * The narrow slice of the Supabase admin client this module uses, declared structurally rather
 * than imported. That keeps the module free of a runtime dependency, so its validation — the
 * security-relevant half, since it bounds what an anonymous caller may send — is unit-testable
 * without a network client or a resolved node_modules tree.
 */
import { backupEmailProblem, normaliseEmail } from '../../../src/lib/backupEmail.ts';

type Failure = { message: string } | null;
type Row = { id?: string };

export interface ProvisionAdminClient {
  from(table: string): {
    insert(rows: unknown): PromiseLike<{ error: Failure }> & {
      select(columns: string): PromiseLike<{ data: Row[] | null; error: Failure }> & {
        single(): PromiseLike<{ data: Row | null; error: Failure }>;
      };
    };
    delete(): { eq(column: string, value: string): PromiseLike<{ error: Failure }> };
    /**
     * READ-BACK, and it is the whole reason this member exists.
     *
     * A PostgREST `delete().eq()` answers `error: null` for three different worlds: the row was
     * removed, the row was never there, and the row was there but the caller could not see it. The
     * rollback treated the first as proved by the absence of an error, so a compensation that
     * removed nothing reported a clean unwind. This asks the only question with one answer.
     *
     * RETURNS `unknown`, AND THAT IS DELIBERATE. Spelling the builder out here — `{ eq(): {
     * maybeSingle(): ... } }` — made `deno check` fail the whole of `public-signup` with TS2589,
     * "type instantiation is excessively deep": `PostgrestQueryBuilder.select` is generic over the
     * schema, the relation and the selected columns, and structurally matching the real one against
     * a hand-written shape forces the compiler to expand all of it. `unknown` costs the checker
     * nothing, every real client satisfies it, and `readBack` below narrows it in ONE place where
     * the shape is written down once and can be read.
     */
    select(columns: string): unknown;
  };
  /** The database's own tenant teardown — see `ROLLBACK_TEARDOWN_RPC`. */
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: Failure }>;
  auth: {
    admin: {
      /**
       * `password` is OPTIONAL, and that is owner ruling #332 in the type system.
       *
       * WHAT GoTrue ACTUALLY DOES with an absent key, because "no password" would be a comforting
       * simplification: it GENERATES a random one and stores its hash. The account is equally
       * unusable either way — the value is not known to us, to the visitor, or to whoever filled
       * the form — so nobody can sign in with a password until `/set-password` replaces it. That
       * is the property #332 needs; `user_metadata.password_pending` is only the marker saying
       * which screen is still owed.
       */
      createUser(input: {
        email: string;
        password?: string;
        email_confirm: boolean;
        user_metadata?: Record<string, unknown>;
      }): PromiseLike<{
        data: { user: { id: string } | null }; error: Failure;
      }>;
      deleteUser(id: string): PromiseLike<{ error: Failure }>;
    };
  };
}

/**
 * A single neutral bucket, NOT the food/beverage/cleaning set from supabase/seed.sql — those
 * describe a legacy tenant's business and would be an invented assumption about what a new
 * customer buys (docs/OPEN-DECISIONS.md:3). `products.category_id` is nullable, so a tenant can
 * also run with none.
 */
export const DEFAULT_CATEGORIES = ['כללי'];

export const MIN_PASSWORD_LENGTH = 10;

export interface ProvisionInput {
  name: string;
  ownerEmail: string;
  ownerName: string;
  /**
   * Absent on the deferred path (`passwordPending`), required on every other one. It is not
   * "optional" in the sense of "may be skipped": `validateProvisionInput` refuses a payload whose
   * two halves disagree, in BOTH directions, so a caller cannot forget a password and cannot
   * smuggle one into the path that exists to have none.
   */
  ownerPassword?: string;
  vatRate?: number;
  categories?: string[];
  /**
   * A second address the owner can be reached at (owner decision #270). Optional here, and
   * optional on purpose: nominating one is only ever REQUIRED when the primary address is a
   * Private Relay forwarder AND enforcement has been switched on, and that decision belongs to
   * the caller — `public-signup` — not to the shape of a tenant.
   *
   * Recording it is NOT verifying it. The profile carries the nominated address; only a redeemed
   * challenge (0255, `verify_backup_email`) makes it count, and nothing sends that challenge yet
   * because `inplace.digital` is not DNS-verified (`DEBT §25`).
   */
  backupEmail?: string;
  /**
   * Operator-created tenants start confirmed: the operator hands the credentials over in person
   * and there is nobody to send a confirmation to. A self-signup starts UNCONFIRMED, so an
   * address the visitor does not control cannot be used to sign in.
   */
  emailConfirmed: boolean;
  /**
   * Owner ruling #332, 02.09.2026: "the password is set only after the e-mail address is
   * confirmed."
   *
   * UNCONFIRMED WAS NOT ENOUGH, and this is the whole finding. A stranger could type YOUR address
   * and THEIR password into the anonymous form. The account was created unconfirmed, so they could
   * not sign in — but the confirmation mail went to you, and the moment you clicked it the account
   * became live with their password on it, as the owner of an organization. Account pre-hijacking,
   * finding 4 of the 02.09.2026 security scan.
   *
   * So the ordering is inverted rather than tightened. On this path the auth user is created with
   * NO password and marked `user_metadata.password_pending`; `/set-password` sets the first one,
   * after the confirmation link has proved who holds the address. Confirming an account a stranger
   * pre-registered now yields an account whose password is a random value nobody holds — not
   * theirs, and not anyone's.
   */
  passwordPending: boolean;
}

export interface ProvisionResult {
  org_id: string;
  owner_user_id: string;
  categories_created: number;
}

export type ProvisionFailure =
  | { kind: 'email_taken'; message: string; leftovers: string[] }
  | { kind: 'failed'; message: string; leftovers: string[] };

export type ProvisionOutcome =
  | { ok: true; result: ProvisionResult }
  | { ok: false; failure: ProvisionFailure };

/** Returns a human-readable problem, or null when the payload is usable. */
export function validateProvisionInput(input: Partial<ProvisionInput>): string | null {
  const name = input.name?.trim();
  if (!name) return 'שם הארגון חסר';
  if (name.length > 200) return 'שם הארגון ארוך מדי';

  const email = input.ownerEmail?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'כתובת אימייל של בעל העסק אינה תקינה';
  }
  if (email.length > 320) return 'כתובת האימייל ארוכה מדי';

  const ownerName = input.ownerName?.trim();
  if (!ownerName) return 'שם בעל העסק חסר';
  if (ownerName.length > 200) return 'שם בעל העסק ארוך מדי';

  /**
   * The two halves have to agree, and the refusal runs in both directions on purpose.
   *
   *   * `passwordPending` with a password is refused, because the point of that path is that no
   *     password exists to be chosen by somebody who has not proved the address. A caller that
   *     could pass one anyway would restore the pre-hijacking hole through a second door.
   *   * No `passwordPending` and no usable password is refused exactly as before, so
   *     `admin-provision` — which sends `body.owner_password ?? ''` — still fails closed when the
   *     operator omitted one.
   */
  if (input.passwordPending) {
    if (input.ownerPassword) return 'סיסמה אינה נקבעת בהרשמה — היא נבחרת אחרי אישור הכתובת';
  } else {
    if (!input.ownerPassword || input.ownerPassword.length < MIN_PASSWORD_LENGTH) {
      return `סיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`;
    }
    if (input.ownerPassword.length > 200) return 'הסיסמה ארוכה מדי';
  }

  if (input.vatRate !== undefined) {
    if (typeof input.vatRate !== 'number' || !Number.isFinite(input.vatRate)
        || input.vatRate < 0 || input.vatRate > 100) {
      return 'שיעור מע״מ אינו תקין';
    }
  }

  if (input.categories !== undefined) {
    if (!Array.isArray(input.categories) || input.categories.some((c) => typeof c !== 'string')) {
      return 'רשימת הקטגוריות אינה תקינה';
    }
  }

  return backupEmailRefusal(input.backupEmail, email);
}

/**
 * Why a nominated backup address is refused, or null when there is nothing to refuse.
 *
 * An ABSENT address is not a refusal here, and that split is the whole point: whether one is
 * REQUIRED is `public-signup`'s decision (it is the side that knows whether enforcement is on and
 * whether the primary is a relay), while whether a supplied one is USABLE is this function's,
 * because a bad address must be refused whoever asked for it and whether or not the requirement
 * is live. So a backup address is validated on every path from the day this ships, and required
 * on none of them.
 */
export function backupEmailRefusal(
  backupEmail: string | undefined,
  primaryEmail: string,
): string | null {
  if (backupEmail === undefined || normaliseEmail(backupEmail) === '') return null;
  switch (backupEmailProblem(backupEmail, primaryEmail)) {
    case 'malformed':
      return 'כתובת האימייל החלופית אינה תקינה';
    case 'too_long':
      return 'כתובת האימייל החלופית ארוכה מדי';
    case 'same_as_primary':
      return 'כתובת האימייל החלופית זהה לכתובת הראשית';
    case 'still_a_relay':
      return 'כתובת האימייל החלופית היא גם כתובת העברה של Apple, ולכן אינה גיבוי';
    default:
      return null;
  }
}

/**
 * The profile column, present only when an address was actually nominated.
 *
 * Spread rather than assigned so an omitted nomination leaves the key OFF the insert entirely.
 * Sending `backup_email: null` would say the same thing to Postgres and something different to
 * the next reader of this code, and it is exactly the shape that turns "the visitor did not
 * answer" into "the visitor answered nothing" the first time somebody adds a partial update here.
 */
function backupEmailColumn(backupEmail: string | undefined): { backup_email?: string } {
  const address = normaliseEmail(backupEmail);
  return address ? { backup_email: address } : {};
}

/**
 * The database function that owns a COMPLETE tenant teardown, filed as a migration request in
 * `artifacts/w3/migration-requests/w3-signup.sql`. It is named here rather than spelled at the call
 * site so the fallback below, the tests, and the request itself all refer to one string.
 */
export const ROLLBACK_TEARDOWN_RPC = 'service_rollback_provisioned_tenant';

/**
 * Is this organization still in the table? The one narrowing site for the `unknown` above.
 *
 * A read that could not RUN is not an absence, so the two are returned separately: `present` says
 * what was found, `problem` says why nothing could be found out. Collapsing them into a boolean is
 * how "we could not check" becomes "there is nothing there".
 */
async function organizationStillPresent(
  admin: ProvisionAdminClient,
  orgId: string,
): Promise<{ present: boolean; problem: string | null }> {
  const query = admin.from('organizations').select('id') as {
    eq(column: string, value: string): {
      maybeSingle(): PromiseLike<{ data: Row | null; error: Failure }>;
    };
  };
  try {
    const { data, error } = await query.eq('id', orgId).maybeSingle();
    if (error) return { present: false, problem: error.message };
    return { present: data !== null, problem: null };
  } catch (e) {
    return { present: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE HAND-WRITTEN COMPENSATION COULD NEVER HAVE WORKED, measured 03.09.2026.
 *
 * Inserting one row into `organizations` fires FIVE `AFTER INSERT` triggers, and they write to six
 * tables. This function deleted rows from two of them.
 *
 *   trigger                              writes to                              this deleted it?
 *   p0_organizations_seed_units          public.org_units                       no  (cascades)
 *   organizations_prelaunch_assistant    public.org_flag_configurations         no  (cascades)
 *   organizations_prelaunch_autonomy     public.org_autonomy_policies           no  (cascades)
 *   zzz_organizations_default_subscription  public.organization_subscriptions   YES
 *   zzz_organizations_referral_code      private.referral_codes                 NO  — RESTRICT
 *   zzz_organizations_usage_anchor       private.organization_usage_anchors     NO  — RESTRICT
 *
 * The last two carry `on delete restrict` (`0185:65`, `0186:84`, unchanged since), so Postgres
 * REFUSES the `delete from organizations` while they stand. Every self-signup that failed after the
 * organization insert therefore left the organization behind — including the commonest failure of
 * all, an address that is already registered (`:305-315` below), where nothing else has even been
 * created yet. That is the production organization `QA-AGENT10-DO-NOT-KEEP`.
 *
 * AND IT CANNOT BE FIXED BY LENGTHENING THE LIST. `supabase/config.toml:6` exposes `public` and
 * `graphql_public` to PostgREST and nothing else, so an Edge function holding the service key has
 * no route to `private.referral_codes` or `private.organization_usage_anchors` at all. A complete
 * compensation is not something this side of the wire can express. The database already owns one —
 * `private.delete_tenant_rows` walks a REGISTRY of every tenant table in foreign-key order, repeats
 * until a whole pass removes nothing, and raises `tenant_delete_orphans_remain` if any stage leaves
 * a row — so the fix is to call it, not to re-derive it here where it would drift again on the next
 * trigger somebody adds.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 * AND WHY THE OLD ONE REPORTED SUCCESS WHILE DOING THIS.
 *
 * It reported a leftover only when a statement returned an error. `delete().eq()` returns
 * `error: null` when it matched nothing, so three of the six tables above were "cleaned" by a
 * statement that touched no row, and a caller reading `leftovers.length === 0` was reading the
 * absence of an exception rather than the absence of a tenant.
 *
 * So the last thing this function does is ASK: is the organization still there? That question has
 * one answer, it does not depend on which mechanism ran, and it stays true when the teardown
 * function lands, when it is renamed, and when somebody adds a seventh trigger.
 *
 * A verification that could not run is NOT a pass. It is reported as its own leftover, because
 * "we do not know whether a tenant survived" and "no tenant survived" are different states and only
 * one of them is safe to say nothing about.
 */
export async function rollbackTenant(
  admin: ProvisionAdminClient,
  created: { orgId?: string; userId?: string },
): Promise<string[]> {
  const leftovers: string[] = [];

  if (created.userId) {
    const { error } = await admin.auth.admin.deleteUser(created.userId);
    if (error) leftovers.push(`auth user ${created.userId}: ${error.message}`);
  }
  if (!created.orgId) return leftovers;

  const orgId = created.orgId;
  /** What was tried and what it said — diagnosis, attached to the verdict rather than mistaken for it. */
  const attempts: string[] = [];

  // 1. The registry-driven teardown. One call, one transaction, every tenant table.
  const teardown = await admin.rpc(ROLLBACK_TEARDOWN_RPC, { p_org_id: orgId });
  if (teardown.error) attempts.push(`${ROLLBACK_TEARDOWN_RPC}: ${teardown.error.message}`);

  // 2. The reachable tables, when it did not run. This is deliberately kept even though it cannot
  //    finish: while the migration is unlanded it still removes what it can, and the verification
  //    below is what stops it being mistaken for a completed rollback.
  if (teardown.error) {
    for (const [table, column] of [
      ['categories', 'org_id'],
      ['organization_subscriptions', 'org_id'],
      ['organizations', 'id'],
    ] as const) {
      const { error } = await admin.from(table).delete().eq(column, orgId);
      if (error) attempts.push(`${table}: ${error.message}`);
    }
  }

  // 3. THE VERDICT. Everything above is an attempt; this is the measurement.
  const check = await organizationStillPresent(admin, orgId);
  const detail = attempts.length > 0 ? ` (${attempts.join('; ')})` : '';
  if (check.problem !== null) {
    leftovers.push(`organization ${orgId}: removal could not be verified — ${check.problem}${detail}`);
  } else if (check.present) {
    leftovers.push(`organization ${orgId}: still present after rollback${detail}`);
  }

  return leftovers;
}

export async function provisionTenant(
  admin: ProvisionAdminClient,
  input: ProvisionInput,
): Promise<ProvisionOutcome> {
  const name = input.name.trim();
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  const ownerName = input.ownerName.trim();
  const categories = (input.categories ?? DEFAULT_CATEGORIES)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const created: { orgId?: string; userId?: string } = {};

  try {
    // Status defaults to active and the plan comes from the 0154 trigger. Provisioning never
    // accepts a client-selected status, deadline or plan: lifecycle and entitlement policy are
    // owned by the database, and a signup form must not be able to ask for Business.
    const orgInsert = await admin
      .from('organizations')
      .insert({ name, ...(input.vatRate !== undefined ? { vat_rate: input.vatRate } : {}) })
      .select('id')
      .single();

    if (orgInsert.error || !orgInsert.data) {
      throw new Error(`יצירת הארגון נכשלה: ${orgInsert.error?.message ?? 'לא הוחזר מזהה'}`);
    }
    created.orgId = orgInsert.data.id as string;

    /**
     * The password key is SPREAD IN, never assigned. `password: undefined` and no `password` key
     * are the same thing to this process and different things on the wire: the admin API is an
     * HTTP call, and a serialized `password: null` is a value GoTrue would have to interpret.
     * Omitting the key is the only spelling of "generate one for me" — GoTrue then stores a random
     * password nobody holds, which is what leaves the account unusable until `/set-password` runs.
     *
     * `user_metadata` carries two things and no more. `password_pending` is the flag `/set-password`
     * reads and clears — a hint about which screen is owed, never an authorization, since anyone
     * holding the session can write it. `organization_name` is there for ONE reader: the
     * confirmation e-mail template, which shows `{{ .Data.organization_name }}` so the person
     * confirming can see which business the link belongs to before they trust it.
     */
    const userCreate = await admin.auth.admin.createUser({
      email: ownerEmail,
      ...(input.passwordPending ? {} : { password: input.ownerPassword }),
      email_confirm: input.emailConfirmed,
      ...(input.passwordPending
        ? { user_metadata: { password_pending: true, organization_name: name, full_name: ownerName } }
        : {}),
    });

    if (userCreate.error || !userCreate.data.user) {
      const message = userCreate.error?.message ?? 'לא הוחזר משתמש';
      const taken = /already|registered|exists/i.test(message);
      const leftovers = await rollbackTenant(admin, created);
      return {
        ok: false,
        failure: taken
          ? { kind: 'email_taken', message: 'כתובת האימייל כבר רשומה במערכת', leftovers }
          : { kind: 'failed', message: `יצירת משתמש הבעלים נכשלה: ${message}`, leftovers },
      };
    }
    created.userId = userCreate.data.user.id;

    const profileInsert = await admin.from('profiles').insert({
      id: created.userId,
      org_id: created.orgId,
      full_name: ownerName,
      role: 'owner',
      active: true,
      ...backupEmailColumn(input.backupEmail),
    });
    if (profileInsert.error) {
      throw new Error(`יצירת פרופיל הבעלים נכשלה: ${profileInsert.error.message}`);
    }

    let categoriesCreated = 0;
    if (categories.length > 0) {
      const catInsert = await admin
        .from('categories')
        .insert(categories.map((c, i) => ({ org_id: created.orgId, name: c, sort: i + 1 })))
        .select('id');
      if (catInsert.error) throw new Error(`יצירת קטגוריות הבסיס נכשלה: ${catInsert.error.message}`);
      categoriesCreated = catInsert.data?.length ?? 0;
    }

    return {
      ok: true,
      result: {
        org_id: created.orgId,
        owner_user_id: created.userId,
        categories_created: categoriesCreated,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const leftovers = await rollbackTenant(admin, created);
    return { ok: false, failure: { kind: 'failed', message, leftovers } };
  }
}

/**
 * The same tenant, for an auth user that already exists (0205).
 *
 * A federated sign-in has already produced the account and already proved the address — Google
 * did both before the browser came back — so there is no user to create and no confirmation to
 * wait for. Everything else is `provisionTenant` unchanged: the organization's status, plan, VAT
 * rate and categories stay the database's to decide, exactly as they are for a password signup.
 *
 * The rollback is narrower on purpose. `created.userId` is left unset even though the profile is
 * keyed by it, so a failure here removes the organization this call made and NEVER the person's
 * auth account: that account predates this call and may be their only way back in.
 */
export async function adoptExistingUserAsOwner(
  admin: ProvisionAdminClient,
  input: {
    name: string;
    ownerUserId: string;
    ownerName: string;
    categories?: string[];
    /** As on `ProvisionInput`: nominated here, proved only by 0255's challenge. */
    backupEmail?: string;
  },
): Promise<ProvisionOutcome> {
  const name = input.name.trim();
  const ownerName = input.ownerName.trim();
  const categories = (input.categories ?? DEFAULT_CATEGORIES)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const created: { orgId?: string; userId?: string } = {};

  try {
    const orgInsert = await admin
      .from('organizations')
      .insert({ name })
      .select('id')
      .single();
    if (orgInsert.error || !orgInsert.data) {
      throw new Error(`יצירת הארגון נכשלה: ${orgInsert.error?.message ?? 'לא הוחזר מזהה'}`);
    }
    created.orgId = orgInsert.data.id as string;

    const profileInsert = await admin.from('profiles').insert({
      id: input.ownerUserId,
      org_id: created.orgId,
      full_name: ownerName,
      role: 'owner',
      active: true,
      ...backupEmailColumn(input.backupEmail),
    });
    if (profileInsert.error) {
      throw new Error(`יצירת פרופיל הבעלים נכשלה: ${profileInsert.error.message}`);
    }

    let categoriesCreated = 0;
    if (categories.length > 0) {
      const catInsert = await admin
        .from('categories')
        .insert(categories.map((c, i) => ({ org_id: created.orgId, name: c, sort: i + 1 })))
        .select('id');
      if (catInsert.error) throw new Error(`יצירת קטגוריות הבסיס נכשלה: ${catInsert.error.message}`);
      categoriesCreated = catInsert.data?.length ?? 0;
    }

    return {
      ok: true,
      result: {
        org_id: created.orgId,
        owner_user_id: input.ownerUserId,
        categories_created: categoriesCreated,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const leftovers = await rollbackTenant(admin, created);
    return { ok: false, failure: { kind: 'failed', message, leftovers } };
  }
}
