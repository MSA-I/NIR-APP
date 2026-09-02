import {
  adoptExistingUserAsOwner,
  MIN_PASSWORD_LENGTH, provisionTenant, rollbackTenant, validateProvisionInput,
  type ProvisionAdminClient,
} from "./provision.ts";

const valid = {
  name: "מסעדת הגפן",
  ownerEmail: "owner@example.test",
  ownerName: "בעלים בדיקה",
  ownerPassword: "a-long-enough-password" as string | undefined,
  emailConfirmed: false,
  passwordPending: false,
};

Deno.test("validation bounds everything an anonymous caller can send", () => {
  if (validateProvisionInput(valid) !== null) throw new Error("a valid payload was rejected");

  const cases: [Partial<typeof valid>, string][] = [
    [{ name: "  " }, "blank organization name"],
    [{ name: "x".repeat(201) }, "over-long organization name"],
    [{ ownerEmail: "not-an-email" }, "malformed email"],
    [{ ownerEmail: `${"x".repeat(320)}@example.test` }, "over-long email"],
    [{ ownerName: "" }, "blank owner name"],
    [{ ownerName: "x".repeat(201) }, "over-long owner name"],
    [{ ownerPassword: "x".repeat(MIN_PASSWORD_LENGTH - 1) }, "short password"],
    // The upper bound matters as much as the lower one: an unbounded password field is a way to
    // make an anonymous request expensive to hash.
    [{ ownerPassword: "x".repeat(201) }, "over-long password"],
    // Owner ruling #332, the direction that is easy to forget: the deferred path exists so that no
    // password is chosen before the address is proved. A caller that could send one anyway would
    // put the pre-hijacking hole back through a second door.
    [{ passwordPending: true }, "a deferred-password payload that still carried a password"],
  ];

  for (const [override, what] of cases) {
    if (validateProvisionInput({ ...valid, ...override }) === null) {
      throw new Error(`${what} was accepted`);
    }
  }

  // And the shape the anonymous door actually sends: no password, and none expected.
  if (validateProvisionInput({ ...valid, ownerPassword: undefined, passwordPending: true }) !== null) {
    throw new Error("the deferred-password payload public-signup sends was rejected");
  }
  // The operator door still fails closed on a missing password, because it does not defer one.
  if (validateProvisionInput({ ...valid, ownerPassword: "" }) === null) {
    throw new Error("an operator payload with no password was accepted");
  }
});

/** A client that records what it was asked to do and answers successfully. */
function recordingAdmin(): {
  admin: ProvisionAdminClient;
  inserts: Record<string, unknown[]>;
  created: {
    emailConfirm?: boolean;
    /** Whether the KEY was present, not what it held: absent and empty are different accounts. */
    hasPasswordKey?: boolean;
    password?: unknown;
    metadata?: Record<string, unknown>;
  };
} {
  const inserts: Record<string, unknown[]> = {};
  const created: {
    emailConfirm?: boolean;
    hasPasswordKey?: boolean;
    password?: unknown;
    metadata?: Record<string, unknown>;
  } = {};
  const admin = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          (inserts[table] ??= []).push(rows);
          const answer = { error: null };
          return Object.assign(Promise.resolve(answer), {
            select: () => ({ single: () => Promise.resolve({ data: { id: "org-1" }, error: null }) }),
          });
        },
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
    auth: {
      admin: {
        createUser(input: {
          email_confirm: boolean;
          password?: string;
          user_metadata?: Record<string, unknown>;
        }) {
          created.emailConfirm = input.email_confirm;
          created.hasPasswordKey = "password" in input;
          created.password = input.password;
          created.metadata = input.user_metadata;
          return Promise.resolve({ data: { user: { id: "user-1" } }, error: null });
        },
        deleteUser: () => Promise.resolve({ error: null }),
      },
    },
  } as unknown as ProvisionAdminClient;
  return { admin, inserts, created };
}

Deno.test("provisioning never writes a caller-selected status or plan", async () => {
  const { admin, inserts } = recordingAdmin();
  const outcome = await provisionTenant(admin, valid);
  if (!outcome.ok) throw new Error("provisioning failed on a valid payload");

  const orgRow = JSON.stringify(inserts["organizations"]?.[0] ?? {});
  for (const forbidden of ["status", "plan_key", "trial_ends_at"]) {
    if (orgRow.includes(forbidden)) {
      throw new Error(`the organization insert carried ${forbidden}, which the database owns`);
    }
  }
});

Deno.test("the public door starts unconfirmed and the operator door does not", async () => {
  const anonymous = recordingAdmin();
  await provisionTenant(anonymous.admin, { ...valid, emailConfirmed: false });
  if (anonymous.created.emailConfirm !== false) {
    throw new Error("a self-signup created a pre-confirmed account, so an unowned address could sign in");
  }

  const operator = recordingAdmin();
  await provisionTenant(operator.admin, { ...valid, emailConfirmed: true });
  if (operator.created.emailConfirm !== true) {
    throw new Error("an operator-created account was left unconfirmed with nobody to confirm it");
  }
});

/**
 * Owner ruling #332, on the wire this module actually writes.
 *
 * The assertion that matters is `"password" in input` and not `input.password === undefined`: the
 * admin API is an HTTP call, so a serialized `password: null` is a value GoTrue has to interpret,
 * while an absent key is the only unambiguous spelling of "generate one nobody holds" — which is
 * what leaves the account unusable until `/set-password` replaces it.
 */
Deno.test("the anonymous door creates an owner with NO password, named for the mail that follows", async () => {
  const anonymous = recordingAdmin();
  const outcome = await provisionTenant(anonymous.admin, {
    ...valid,
    ownerPassword: undefined,
    passwordPending: true,
  });
  if (!outcome.ok) throw new Error("the deferred-password path failed on a valid payload");

  if (anonymous.created.hasPasswordKey !== false) {
    throw new Error("a self-signup still sent a password, so a stranger can set one on your address");
  }
  if (anonymous.created.emailConfirm !== false) {
    throw new Error("a self-signup created a pre-confirmed account, so an unowned address could sign in");
  }
  if (anonymous.created.metadata?.password_pending !== true) {
    throw new Error("the owner was not marked as owing a password, so /set-password is never offered");
  }
  // The confirmation template shows this so the reader can see which business the link belongs to
  // before they trust it.
  if (anonymous.created.metadata?.organization_name !== "מסעדת הגפן") {
    throw new Error("the confirmation mail has no business name to show");
  }

  // The operator door is unchanged: it hands the credentials over in person.
  const operator = recordingAdmin();
  await provisionTenant(operator.admin, { ...valid, emailConfirmed: true });
  if (operator.created.password !== "a-long-enough-password") {
    throw new Error("the operator door stopped setting the password the operator chose");
  }
  if (operator.created.metadata?.password_pending === true) {
    throw new Error("an operator-created owner was told to set a password nobody will ask them for");
  }
});

Deno.test("a failure after the organization exists unwinds it, and reports what it could not", async () => {
  const failures: string[] = [];
  const admin = {
    from(table: string) {
      return {
        insert() {
          const answer = { error: table === "profiles" ? { message: "boom" } : null };
          return Object.assign(Promise.resolve(answer), {
            select: () => ({ single: () => Promise.resolve({ data: { id: "org-1" }, error: null }) }),
          });
        },
        // The organization refuses to be deleted: the caller must hear about the leftover rather
        // than receive a clean-looking failure.
        delete: () => ({
          eq: () => Promise.resolve({
            error: table === "organizations" ? { message: "still referenced" } : null,
          }),
        }),
      };
    },
    auth: {
      admin: {
        createUser: () => Promise.resolve({ data: { user: { id: "user-1" } }, error: null }),
        deleteUser: () => Promise.resolve({ error: null }),
      },
    },
  } as unknown as ProvisionAdminClient;

  const outcome = await provisionTenant(admin, valid);
  if (outcome.ok) throw new Error("a failed profile insert reported success");
  if (outcome.failure.leftovers.length === 0) {
    throw new Error("a rollback that could not finish reported nothing");
  }
  failures.push(...outcome.failure.leftovers);
  if (!failures.join(" ").includes("organization")) {
    throw new Error("the un-deletable organization was not named in the leftovers");
  }
});

Deno.test("an already-registered address is a distinct outcome, so a door can choose to hide it", async () => {
  // The shared core reports `email_taken`; public-signup deliberately answers it with the same
  // sentence as success so the endpoint cannot be used to enumerate accounts, while
  // admin-provision surfaces it as 409 to an operator who is entitled to know.
  const admin = {
    from() {
      return {
        insert() {
          return Object.assign(Promise.resolve({ error: null }), {
            select: () => ({ single: () => Promise.resolve({ data: { id: "org-1" }, error: null }) }),
          });
        },
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
    auth: {
      admin: {
        createUser: () => Promise.resolve({
          data: { user: null }, error: { message: "A user with this email address has already been registered" },
        }),
        deleteUser: () => Promise.resolve({ error: null }),
      },
    },
  } as unknown as ProvisionAdminClient;

  const outcome = await provisionTenant(admin, valid);
  if (outcome.ok) throw new Error("a duplicate address provisioned a tenant");
  if (outcome.failure.kind !== "email_taken") {
    throw new Error(`a duplicate address reported ${outcome.failure.kind}`);
  }
});

Deno.test("rollback removes the subscription the database trigger created", async () => {
  // 0154 attaches a default subscription to every new organization. A rollback that forgot it
  // would leave the organization undeletable and the failure unexplained.
  const deleted: string[] = [];
  const admin = {
    from(table: string) {
      return {
        insert: () => Object.assign(Promise.resolve({ error: null }), {
          select: () => ({ single: () => Promise.resolve({ data: { id: "org-1" }, error: null }) }),
        }),
        delete: () => ({ eq: () => { deleted.push(table); return Promise.resolve({ error: null }); } }),
      };
    },
    auth: { admin: { createUser: () => Promise.resolve({ data: { user: null }, error: null }), deleteUser: () => Promise.resolve({ error: null }) } },
  } as unknown as ProvisionAdminClient;

  await rollbackTenant(admin, { orgId: "org-1", userId: "user-1" });
  if (!deleted.includes("organization_subscriptions")) {
    throw new Error("rollback left the default subscription behind");
  }
  if (deleted.indexOf("organizations") < deleted.indexOf("organization_subscriptions")) {
    throw new Error("the organization was deleted before the rows referencing it");
  }
});

Deno.test("public signup never returns rollback leftovers to an anonymous caller", async () => {
  const source = await Deno.readTextFile(
    new URL("../public-signup/index.ts", import.meta.url),
  );
  const publicFailure = source.match(
    /code\s*:\s*'signup_failed'[\s\S]*?\},\s*500\);/,
  );
  if (!publicFailure) {
    throw new Error("public-signup no longer exposes a reviewable generic failure contract");
  }
  if (/\bdetail\s*:/.test(publicFailure[0])) {
    throw new Error(
      "public-signup exposes internal cleanup identifiers and database errors in its response",
    );
  }
});

/**
 * A client for the federated door: it records deletions and can be told to fail one insert.
 *
 * `createUser` throws rather than returning, because the whole point of this path is that GoTrue
 * already made the account. A regression that reintroduced the call would otherwise pass silently.
 */
function adoptionAdmin(failInsertOn?: string): {
  admin: ProvisionAdminClient;
  deletedUsers: string[];
  deleted: string[];
  inserts: Record<string, unknown[]>;
} {
  const deletedUsers: string[] = [];
  const deleted: string[] = [];
  const inserts: Record<string, unknown[]> = {};
  const admin = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          (inserts[table] ??= []).push(rows);
          const error = table === failInsertOn ? { message: `${table} refused` } : null;
          return Object.assign(Promise.resolve({ error }), {
            select: () => Object.assign(
              Promise.resolve({ data: error ? null : [{ id: "cat-1" }], error }),
              { single: () => Promise.resolve({ data: error ? null : { id: "org-9" }, error }) },
            ),
          });
        },
        delete: () => ({
          eq: (_column: string, _value: string) => {
            deleted.push(table);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    auth: {
      admin: {
        createUser: () => {
          throw new Error("the federated path must never create an auth user");
        },
        deleteUser: (id: string) => {
          deletedUsers.push(id);
          return Promise.resolve({ error: null });
        },
      },
    },
  } as unknown as ProvisionAdminClient;
  return { admin, deletedUsers, deleted, inserts };
}

Deno.test("adopting an existing identity keys the owner profile by the id it was handed", async () => {
  const { admin, inserts } = adoptionAdmin();
  const outcome = await adoptExistingUserAsOwner(admin, {
    name: "מסעדת הגפן",
    ownerUserId: "google-user-7",
    ownerName: "בעלים בדיקה",
  });
  if (!outcome.ok) throw new Error("adoption failed on a valid payload");

  const profile = (inserts.profiles?.[0] ?? {}) as Record<string, unknown>;
  if (profile.id !== "google-user-7") throw new Error("the profile was not keyed by the auth user");
  if (profile.role !== "owner") throw new Error("a federated signup produced a role other than owner");
  if (outcome.result.owner_user_id !== "google-user-7") {
    throw new Error("the outcome reported an owner this call did not adopt");
  }
  // Status, plan and VAT stay the database's, exactly as on the password path.
  const org = (inserts.organizations?.[0] ?? {}) as Record<string, unknown>;
  for (const forbidden of ["status", "plan", "vat_rate", "subscription_plan_id"]) {
    if (forbidden in org) throw new Error(`the federated door wrote ${forbidden}`);
  }
});

Deno.test("a failed adoption removes the organization and NEVER the pre-existing auth account", async () => {
  const { admin, deletedUsers, deleted } = adoptionAdmin("profiles");
  const outcome = await adoptExistingUserAsOwner(admin, {
    name: "מסעדת הגפן",
    ownerUserId: "google-user-7",
    ownerName: "בעלים בדיקה",
  });
  if (outcome.ok) throw new Error("a refused profile insert reported success");

  // The organization this call created is unwound...
  for (const table of ["categories", "organization_subscriptions", "organizations"]) {
    if (!deleted.includes(table)) throw new Error(`rollback left ${table} behind`);
  }
  // ...and the person's identity, which predates this call and may be their only way back in, is
  // not. Deleting it would lock them out of an account this code never created.
  if (deletedUsers.length > 0) {
    throw new Error(`rollback deleted auth user(s) it did not create: ${deletedUsers.join(", ")}`);
  }
});
