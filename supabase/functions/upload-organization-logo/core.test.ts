import {
  MAX_LOGO_BYTES,
  organizationCanManageBranding,
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
  assert(
    organizationCanManageBranding({ active: true, role: "owner" }, {
      access_mode: "grace",
    }),
  );
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
