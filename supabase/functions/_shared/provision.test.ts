import {
  MIN_PASSWORD_LENGTH, provisionTenant, rollbackTenant, validateProvisionInput,
  type ProvisionAdminClient,
} from "./provision.ts";

const valid = {
  name: "מסעדת הגפן",
  ownerEmail: "owner@example.test",
  ownerName: "בעלים בדיקה",
  ownerPassword: "a-long-enough-password",
  emailConfirmed: false,
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
  ];

  for (const [override, what] of cases) {
    if (validateProvisionInput({ ...valid, ...override }) === null) {
      throw new Error(`${what} was accepted`);
    }
  }
});

/** A client that records what it was asked to do and answers successfully. */
function recordingAdmin(): { admin: ProvisionAdminClient; inserts: Record<string, unknown[]>; created: { emailConfirm?: boolean } } {
  const inserts: Record<string, unknown[]> = {};
  const created: { emailConfirm?: boolean } = {};
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
        createUser(input: { email_confirm: boolean }) {
          created.emailConfirm = input.email_confirm;
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
