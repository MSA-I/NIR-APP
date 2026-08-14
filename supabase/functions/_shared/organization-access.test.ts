import { organizationWriteAllowed } from "./organization-access.ts";

Deno.test("organization access preflight consumes the canonical server projection", () => {
  if (!organizationWriteAllowed({ access_mode: "active" })) {
    throw new Error("active rejected");
  }
  for (const access_mode of ["trial", "grace", "read_only", "offboarding", "suspended"]) {
    if (organizationWriteAllowed({ access_mode })) throw new Error(`${access_mode} accepted`);
  }
  if (organizationWriteAllowed(null)) throw new Error("missing evidence accepted");
});
