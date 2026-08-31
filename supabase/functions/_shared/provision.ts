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
  };
  auth: {
    admin: {
      createUser(input: { email: string; password: string; email_confirm: boolean }): PromiseLike<{
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
  ownerPassword: string;
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

  if (!input.ownerPassword || input.ownerPassword.length < MIN_PASSWORD_LENGTH) {
    return `סיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`;
  }
  if (input.ownerPassword.length > 200) return 'הסיסמה ארוכה מדי';

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

export async function rollbackTenant(
  admin: ProvisionAdminClient,
  created: { orgId?: string; userId?: string },
): Promise<string[]> {
  const leftovers: string[] = [];

  if (created.userId) {
    const { error } = await admin.auth.admin.deleteUser(created.userId);
    if (error) leftovers.push(`auth user ${created.userId}: ${error.message}`);
  }
  if (created.orgId) {
    // Categories before the organization they reference; the profile goes with the auth user
    // through the cascade on auth.users (0001_init.sql:32).
    const cats = await admin.from('categories').delete().eq('org_id', created.orgId);
    if (cats.error) leftovers.push(`categories of org ${created.orgId}: ${cats.error.message}`);

    // The default-subscription trigger (0154) put a row here; it references the organization.
    const sub = await admin.from('organization_subscriptions').delete().eq('org_id', created.orgId);
    if (sub.error) leftovers.push(`subscription of org ${created.orgId}: ${sub.error.message}`);

    const org = await admin.from('organizations').delete().eq('id', created.orgId);
    if (org.error) leftovers.push(`organization ${created.orgId}: ${org.error.message}`);
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

    const userCreate = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: input.ownerPassword,
      email_confirm: input.emailConfirmed,
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
