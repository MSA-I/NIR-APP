import {
  MAX_LOGO_BYTES,
  organizationCanManageBranding,
  supplierCanManageBranding,
  supplierLogoObjectPath,
  validatedLogoType,
} from "./core.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("expected truthy value");
}

Deno.test("branding accepts only matching PNG JPEG and WebP signatures", () => {
  assert(
    validatedLogoType(
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        0,
      ]),
      "image/png",
      12,
    ),
  );
  assert(
    validatedLogoType(
      new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      "image/jpeg",
      12,
    ),
  );
  assert(
    validatedLogoType(
      new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0,
        0,
        0,
        0,
        0x57,
        0x45,
        0x42,
        0x50,
      ]),
      "image/webp",
      12,
    ),
  );
});

Deno.test("branding rejects spoofed type and oversized input", () => {
  const html = new TextEncoder().encode("<html>bad</html>");
  if (validatedLogoType(html, "image/png", html.length)) {
    throw new Error("accepted spoofed PNG");
  }
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    0,
  ]);
  if (validatedLogoType(png, "image/png", MAX_LOGO_BYTES + 1)) {
    throw new Error("accepted oversized logo");
  }
});

Deno.test("branding rejects inactive owners and canonical read-only tenants", () => {
  assert(
    organizationCanManageBranding({ active: true, role: "owner" }, {
      access_mode: "active",
    }),
  );
  if (
    organizationCanManageBranding({ active: true, role: "owner" }, {
      access_mode: "grace",
    })
  ) {
    throw new Error("accepted retired grace tenant");
  }
  if (
    organizationCanManageBranding({ active: true, role: "owner" }, {
      access_mode: "offboarding",
    })
  ) {
    throw new Error("accepted offboarding tenant");
  }
  if (
    organizationCanManageBranding({ active: false, role: "owner" }, {
      access_mode: "active",
    })
  ) {
    throw new Error("accepted inactive owner");
  }
});

Deno.test("a supplier logo is office work and the organisation's own logo is not", () => {
  const writable = { access_mode: "active" };

  // The whole reason two predicates exist. `office` runs the supplier list day to day, so
  // requiring the owner for a supplier's logo would move routine work to the wrong person; the
  // organisation's own identity is a different question and stays with the owner.
  assert(
    supplierCanManageBranding({ active: true, role: "office" }, writable) === true,
  );
  assert(
    organizationCanManageBranding({ active: true, role: "office" }, writable) ===
      false,
  );

  // Owner keeps both.
  assert(
    supplierCanManageBranding({ active: true, role: "owner" }, writable) === true,
  );

  // And no other role gets either, whichever logo is being written. `accountant` is the one worth
  // naming: it can read a great deal of this tenant and must still write no branding at all.
  for (const role of ["accountant", "kitchen", "payer", "supplier"]) {
    assert(supplierCanManageBranding({ active: true, role }, writable) === false);
    assert(
      organizationCanManageBranding({ active: true, role }, writable) === false,
    );
  }

  // An inactive member is nobody, and a tenant that may not be written to is closed to both --
  // otherwise a suspended organisation could still rebrand itself on the way out.
  assert(
    supplierCanManageBranding({ active: false, role: "owner" }, writable) === false,
  );
  assert(
    supplierCanManageBranding({ active: true, role: "owner" }, null) === false,
  );
});

Deno.test("the supplier logo path is tenant-prefixed and supplier-scoped", () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const supplier = "22222222-2222-4222-8222-222222222222";
  const object = "33333333-3333-4333-8333-333333333333";
  const path = supplierLogoObjectPath(org, supplier, object, "png");

  assert(path === `${org}/suppliers/${supplier}/${object}.png`);

  // THE SAME REGEX `0275` PUTS ON THE COLUMN. If these two ever disagree the upload succeeds and
  // the row write fails, leaving a file in the bucket that nothing points at -- so the shape is
  // asserted here against the constraint's own pattern rather than against a description of it.
  const constraint = new RegExp(
    `^${org}/suppliers/${supplier}` +
      "/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|webp)$",
  );
  assert(constraint.test(path));

  // The path always begins with the organisation, which is what the bucket policy reads. A build
  // that put the supplier first would still look plausible and would address the wrong folder.
  assert(path.startsWith(`${org}/`));
  assert(constraint.test(supplierLogoObjectPath(org, supplier, object, "jpg")));
  assert(constraint.test(supplierLogoObjectPath(org, supplier, object, "webp")));

  // And an extension the bucket does not allow does not match the column either, so neither half
  // can be the only thing standing between an SVG and the tenant's branding folder.
  assert(constraint.test(supplierLogoObjectPath(org, supplier, object, "svg")) === false);
});
