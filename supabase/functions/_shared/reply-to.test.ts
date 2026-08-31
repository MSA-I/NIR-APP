import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  replyToField,
  resolveTenantReplyAddress,
  sanitizeReplyAddress,
  SUPPORT_REPLY_TO,
} from "./reply-to.ts";

// ===== The header-injection cases, first, because they are the reason this module exists =====

Deno.test("a newline in the address is refused, so a header cannot be split", () => {
  assertEquals(sanitizeReplyAddress("buyer@tenant.example\nBcc: attacker@evil.example"), null);
  assertEquals(sanitizeReplyAddress("buyer@tenant.example\r\nBcc: attacker@evil.example"), null);
  assertEquals(sanitizeReplyAddress("buyer@tenant.example\r"), null);
});

Deno.test("a NUL or other control character is refused", () => {
  assertEquals(sanitizeReplyAddress("buyer\u0000@tenant.example"), null);
  assertEquals(sanitizeReplyAddress("buyer@tenant.example\u007F"), null);
});

Deno.test("a second recipient cannot be smuggled in one string", () => {
  assertEquals(sanitizeReplyAddress("buyer@tenant.example, attacker@evil.example"), null);
  assertEquals(sanitizeReplyAddress("buyer@tenant.example; attacker@evil.example"), null);
});

Deno.test("angle brackets and display names are refused -- we author the header, not the caller", () => {
  assertEquals(sanitizeReplyAddress("<buyer@tenant.example>"), null);
  assertEquals(sanitizeReplyAddress('"InPlace Support" <buyer@tenant.example>'), null);
  assertEquals(sanitizeReplyAddress("Buyer buyer@tenant.example"), null);
});

// ===== Shape =====

Deno.test("an ordinary address is accepted and lowercased", () => {
  assertEquals(sanitizeReplyAddress("Buyer@Tenant.Example"), "buyer@tenant.example");
  assertEquals(sanitizeReplyAddress("  buyer.name+po@tenant.co.il  "), "buyer.name+po@tenant.co.il");
});

Deno.test("a non-address is refused rather than passed through", () => {
  for (const value of ["", "   ", "buyer", "buyer@", "@tenant.example", "buyer@tenant",
                       "buyer@@tenant.example", "buyer@-tenant.example", "buyer@tenant-.example"]) {
    assertEquals(sanitizeReplyAddress(value), null, `expected refusal for ${JSON.stringify(value)}`);
  }
});

Deno.test("a non-string is refused without coercion", () => {
  for (const value of [null, undefined, 42, {}, [], { toString: () => "b@t.example" }]) {
    assertEquals(sanitizeReplyAddress(value), null);
  }
});

Deno.test("an address longer than a mail system accepts is refused", () => {
  const long = `${"a".repeat(250)}@tenant.example`;
  assertEquals(sanitizeReplyAddress(long), null);
});

// ===== Resolution =====

Deno.test("the acting user's verified address becomes the tenant reply address", () => {
  assertEquals(resolveTenantReplyAddress("office@tenant.example"),
    { address: "office@tenant.example", source: "actor" });
});

Deno.test("no usable actor address yields `none`, and never InPlace support", () => {
  for (const value of [null, undefined, "", "not-an-address", "a@b.example\nBcc: x@y.example"]) {
    const resolved = resolveTenantReplyAddress(value);
    assertEquals(resolved, { address: null, source: "none" });
    assertEquals(resolved.address === SUPPORT_REPLY_TO, false);
  }
});

Deno.test("a supplier order never falls back to InPlace support", () => {
  // The property, stated as a test so a future 'helpful' default cannot land quietly: whatever
  // the actor address is, the resolved tenant address is either that address or nothing.
  for (const value of ["office@tenant.example", "", null, "garbage"]) {
    const { address } = resolveTenantReplyAddress(value);
    assertEquals(address === SUPPORT_REPLY_TO, false);
  }
});

// ===== The provider field =====

Deno.test("replyToField omits the key entirely when there is no address", () => {
  assertEquals(replyToField(null), undefined);
  // The property that matters: JSON.stringify drops it, so the provider sees no reply_to at all.
  assertEquals(JSON.stringify({ from: "x@y.example", reply_to: replyToField(null) }),
    '{"from":"x@y.example"}');
});

Deno.test("replyToField passes a resolved address through unchanged", () => {
  assertEquals(replyToField("office@tenant.example"), "office@tenant.example");
});

Deno.test("support is a constant on the InPlace domain", () => {
  assertEquals(SUPPORT_REPLY_TO, "support@inplace.digital");
  assertEquals(sanitizeReplyAddress(SUPPORT_REPLY_TO), SUPPORT_REPLY_TO);
});
