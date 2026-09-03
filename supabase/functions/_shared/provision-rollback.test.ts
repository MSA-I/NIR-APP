/**
 * THE FAILURE-INJECTION GATE for tenant provisioning — one injected failure per step, and after
 * each one the question "is anything left?" is answered by READING THE STORE, not by trusting the
 * absence of an error.
 *
 * WHY A SEPARATE FILE FROM `provision.test.ts`. That file's fakes answer `{ error: null }` to every
 * statement and record which tables were ASKED to delete. That is the exact assumption the live
 * defect hid behind: `rollbackTenant` asked `organizations` to delete, the fake said yes, the test
 * went green, and in production Postgres refused the statement because two `on delete restrict`
 * children were still standing. A mock that cannot refuse cannot catch a refusal.
 *
 * So the fake here is a small DATABASE, not a call recorder:
 *
 *   · rows live in a map and are actually removed;
 *   · `AFTER INSERT` triggers on `organizations` write the six child tables the live ones write;
 *   · foreign keys carry the real `on delete` rule, read off the migrations and confirmed against
 *     the local stack on 03.09.2026 — `cascade` for `org_units`, `org_flag_configurations` and
 *     `org_autonomy_policies`; `restrict` for `organization_subscriptions`,
 *     `private.referral_codes` and `private.organization_usage_anchors`;
 *   · a delete that would orphan a `restrict` child FAILS, exactly as Postgres fails it;
 *   · anything under the `private.` schema is UNREACHABLE, because `supabase/config.toml:6` exposes
 *     `public` and `graphql_public` to PostgREST and no Edge function can address the rest.
 *
 * WHAT THE GATE PROVES, stated so a green run cannot be read as more than it is:
 *
 *   1. With the teardown function present, a failure injected at EACH step of provisioning leaves
 *      ZERO rows in every table — immediately, in the same request, not after a next-day sweep.
 *   2. Without it, the rollback does not pretend: the organization survives and is REPORTED as a
 *      leftover by name. Under the pre-03.09 code this same scenario reported nothing at all.
 *   3. The reported leftover is a measurement. A store that silently ignores the delete — the
 *      PostgREST `error: null` on a statement that matched nothing — is still caught.
 *
 * WHAT IT DOES NOT PROVE. It is a model of the database, not the database. It cannot see a trigger
 * added after 03.09.2026, and that is precisely why the fix routes through the registry-driven
 * `private.delete_tenant_rows` rather than through a list in TypeScript: the model is a check on
 * this code, and the registry is what keeps the real thing complete.
 */
import {
  adoptExistingUserAsOwner, provisionTenant, ROLLBACK_TEARDOWN_RPC,
  type ProvisionAdminClient,
} from "./provision.ts";

const ORG_ID = "org-under-test";
const USER_ID = "user-under-test";

/** `on delete` as the migrations declare it, for every child a provisioning insert creates. */
const CHILDREN = [
  { table: "public.org_units", rule: "cascade", rows: 4 },
  { table: "public.org_flag_configurations", rule: "cascade", rows: 2 },
  { table: "public.org_autonomy_policies", rule: "cascade", rows: 4 },
  // 0154's default-subscription trigger. The only child the old hand-written rollback removed.
  { table: "public.organization_subscriptions", rule: "restrict", rows: 1 },
  // 0186:84 — `on delete restrict`, and in a schema PostgREST does not expose.
  { table: "private.referral_codes", rule: "restrict", rows: 1 },
  // 0185:65 — the same, and the second of the two that made the delete impossible.
  { table: "private.organization_usage_anchors", rule: "restrict", rows: 1 },
] as const;

type Step = "organization" | "user" | "profile" | "categories";

interface Store {
  rows: Map<string, number>;
  /** Tables a `public`-schema client asked to delete, whether or not the store obeyed. */
  asked: string[];
  remaining(): string[];
}

function newStore(): Store {
  const rows = new Map<string, number>();
  return {
    rows,
    asked: [],
    remaining: () => [...rows.entries()].filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`),
  };
}

const bump = (store: Store, table: string, by: number) =>
  store.rows.set(table, (store.rows.get(table) ?? 0) + by);

/**
 * A client over that store.
 *
 * `teardown` chooses whether the database has the registry-driven function yet, which is the whole
 * difference between the two halves of this gate.
 */
function client(
  store: Store,
  options: { failAt?: Step; teardown: boolean },
): ProvisionAdminClient {
  const qualified = (table: string) => (table.includes(".") ? table : `public.${table}`);

  const removeTenant = (): { ok: true } | { ok: false; message: string } => {
    // What `private.delete_tenant_rows` does: every registered table, then the organization row,
    // in one transaction, with an orphan check that raises rather than half-finishing.
    for (const child of CHILDREN) store.rows.set(child.table, 0);
    store.rows.set("public.categories", 0);
    store.rows.set("public.profiles", 0);
    store.rows.set("public.organizations", 0);
    return { ok: true };
  };

  return {
    from(table: string) {
      const name = qualified(table);
      return {
        insert(rows: unknown) {
          const count = Array.isArray(rows) ? rows.length : 1;
          const failed = (options.failAt === "profile" && name === "public.profiles")
            || (options.failAt === "categories" && name === "public.categories")
            || (options.failAt === "organization" && name === "public.organizations");
          if (!failed) bump(store, name, count);
          const answer = { error: failed ? { message: `${table} refused` } : null };
          return Object.assign(Promise.resolve(answer), {
            select: () => Object.assign(
              Promise.resolve({ data: failed ? null : [{ id: ORG_ID }], error: answer.error }),
              {
                single: () => {
                  if (!failed && name === "public.organizations") {
                    // The five AFTER INSERT triggers, by what they actually write.
                    for (const child of CHILDREN) bump(store, child.table, child.rows);
                  }
                  return Promise.resolve({ data: failed ? null : { id: ORG_ID }, error: answer.error });
                },
              },
            ),
          });
        },
        delete: () => ({
          eq: (_column: string, _value: string) => {
            store.asked.push(name);
            // PostgREST reaches `public` only. A statement against `private` never leaves the
            // client, and this is why lengthening the hand-written list cannot fix the rollback.
            if (name.startsWith("private.")) {
              return Promise.resolve({ error: { message: "schema private is not exposed" } });
            }
            if (name === "public.organizations") {
              const blocking = CHILDREN
                .filter((c) => c.rule === "restrict" && (store.rows.get(c.table) ?? 0) > 0)
                .map((c) => c.table);
              if (blocking.length > 0) {
                return Promise.resolve({
                  error: {
                    message: `update or delete on table "organizations" violates foreign key `
                      + `constraint on table "${blocking[0]}"`,
                  },
                });
              }
              store.rows.set("public.organizations", 0);
              for (const child of CHILDREN) {
                if (child.rule === "cascade") store.rows.set(child.table, 0);
              }
              return Promise.resolve({ error: null });
            }
            // A delete that matches nothing is not an error — the behaviour the old rollback read
            // as proof that it had cleaned the table.
            store.rows.set(name, 0);
            return Promise.resolve({ error: null });
          },
        }),
        select: (_columns: string) => ({
          eq: (_column: string, _value: string) => ({
            maybeSingle: () => Promise.resolve({
              data: (store.rows.get(name) ?? 0) > 0 ? { id: ORG_ID } : null,
              error: null,
            }),
          }),
        }),
      };
    },
    rpc: (name: string) => {
      if (name !== ROLLBACK_TEARDOWN_RPC) return Promise.resolve({ data: null, error: null });
      if (!options.teardown) {
        // What PostgREST answers for a function that has not been created yet.
        return Promise.resolve({
          data: null,
          error: { message: `Could not find the function public.${name}(p_org_id) in the schema cache` },
        });
      }
      const done = removeTenant();
      return Promise.resolve({ data: done.ok ? { removed: true } : null, error: null });
    },
    auth: {
      admin: {
        createUser: () => {
          if (options.failAt === "user") {
            return Promise.resolve({
              data: { user: null },
              error: { message: "A user with this email address has already been registered" },
            });
          }
          bump(store, "auth.users", 1);
          return Promise.resolve({ data: { user: { id: USER_ID } }, error: null });
        },
        deleteUser: (_id: string) => {
          store.rows.set("auth.users", 0);
          store.rows.set("public.profiles", 0); // 0001_init.sql:32 — the profile cascades.
          return Promise.resolve({ error: null });
        },
      },
    },
  } as unknown as ProvisionAdminClient;
}

const payload = {
  name: "מסעדת הגפן",
  ownerEmail: "owner@example.test",
  ownerName: "בעלים בדיקה",
  emailConfirmed: false,
  passwordPending: true,
};

/**
 * 1. THE GATE. A failure at each step, and zero rows left immediately after each one.
 *
 * `organization` is in the list even though nothing exists to unwind when the very first insert
 * fails: a rollback that mishandled the empty case would be a new way to lose a tenant, and it
 * costs one line to hold it.
 */
for (const step of ["organization", "user", "profile", "categories"] as const) {
  Deno.test(`failure injected at the ${step} step leaves nothing behind`, async () => {
    const store = newStore();
    const outcome = await provisionTenant(client(store, { failAt: step, teardown: true }), payload);

    if (outcome.ok) throw new Error(`provisioning reported success with the ${step} step failing`);
    const left = store.remaining();
    if (left.length > 0) {
      throw new Error(
        `a failure at the ${step} step left rows behind: ${left.join(", ")} — `
        + "an orphaned tenant, in the same request",
      );
    }
    if (outcome.failure.leftovers.length > 0) {
      throw new Error(
        `the store is empty but the rollback reported leftovers: ${outcome.failure.leftovers.join("; ")}`,
      );
    }
  });
}

Deno.test("the federated door unwinds the same way, and never the pre-existing account", async () => {
  const store = newStore();
  bump(store, "auth.users", 1); // Google made this account before the request arrived.
  const outcome = await adoptExistingUserAsOwner(
    client(store, { failAt: "profile", teardown: true }),
    { name: "מסעדת הגפן", ownerUserId: "google-user-7", ownerName: "בעלים בדיקה" },
  );
  if (outcome.ok) throw new Error("a refused profile insert reported success");

  const left = store.remaining();
  if (left.some((row) => !row.startsWith("auth.users"))) {
    throw new Error(`the federated rollback left tenant rows behind: ${left.join(", ")}`);
  }
  if ((store.rows.get("auth.users") ?? 0) !== 1) {
    throw new Error("the rollback deleted an auth account it did not create");
  }
  if (outcome.failure.leftovers.length > 0) {
    throw new Error(`clean store, reported leftovers: ${outcome.failure.leftovers.join("; ")}`);
  }
});

/**
 * 2. THE REGRESSION ITSELF, held as its own test so it fails loudly if the teardown is ever removed
 *    again rather than quietly going back to being invisible.
 *
 *    This is `QA-AGENT10-DO-NOT-KEEP` reproduced: an address that is already registered, the
 *    commonest failure this door has, at the step where NOTHING but the organization and its
 *    trigger rows exist yet.
 */
Deno.test("without the teardown function the organization survives — and is REPORTED, not swallowed", async () => {
  const store = newStore();
  const outcome = await provisionTenant(client(store, { failAt: "user", teardown: false }), payload);
  if (outcome.ok) throw new Error("a duplicate address provisioned a tenant");
  if (outcome.failure.kind !== "email_taken") {
    throw new Error(`a duplicate address reported ${outcome.failure.kind}`);
  }

  // The organization is still there, because two `on delete restrict` children are.
  if ((store.rows.get("public.organizations") ?? 0) !== 1) {
    throw new Error("the model no longer reproduces the defect — check CHILDREN against the migrations");
  }
  // ...and the caller is told so, by organization id. Before 03.09.2026 this list was empty: every
  // statement the rollback issued returned `error: null` except the last, and nothing read it back.
  const said = outcome.failure.leftovers.join("; ");
  if (!said.includes(ORG_ID) || !/still present/.test(said)) {
    throw new Error(`the surviving organization was not reported: ${said || "(nothing)"}`);
  }
});

/**
 * 3. AND THE FAILURE MODE THE OLD ONE WAS BUILT ON: a store that answers "fine" to a delete that
 *    removed nothing. No error anywhere, and the verdict must still be "there is a tenant here".
 */
Deno.test("a rollback whose deletes all succeed but remove nothing is still a leftover", async () => {
  const store = newStore();
  const admin = client(store, { failAt: "profile", teardown: false });
  const deaf = {
    ...admin,
    from(table: string) {
      const real = admin.from(table);
      return { ...real, delete: () => ({ eq: () => Promise.resolve({ error: null }) }) };
    },
  } as unknown as ProvisionAdminClient;

  const outcome = await provisionTenant(deaf, { ...payload, name: "בדיקת חירשות" });
  if (outcome.ok) throw new Error("the deaf client provisioned a tenant it should not have");
  if (outcome.failure.leftovers.length === 0) {
    throw new Error(
      "every delete answered `error: null`, nothing was removed, and the rollback called it clean",
    );
  }
});
