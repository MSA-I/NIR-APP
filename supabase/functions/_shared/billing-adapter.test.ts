import { billingAdapterFor, manualBillingAdapter } from "./billing-adapter.ts";

Deno.test("the manual adapter refuses what it cannot do, by name", async () => {
  const checkout = await manualBillingAdapter.createCheckoutSession({
    orgId: "51000000-0000-4000-8000-000000000001",
    planKey: "pro",
    interval: "monthly",
  });
  if (checkout.ok) throw new Error("a checkout session was produced with no provider configured");
  if (checkout.code !== "not_configured") throw new Error(`wrong refusal code: ${checkout.code}`);

  const cancel = await manualBillingAdapter.cancelSubscription("sub_whatever");
  if (cancel.ok) throw new Error("a cancellation succeeded with no provider configured");
});

Deno.test("an unsigned webhook body is never parsed into an event", () => {
  // The refusal is the correct behaviour, not a placeholder: there is no secret to verify
  // against, and an adapter that accepted unsigned payloads would be the hole this boundary
  // exists to prevent.
  const parsed = manualBillingAdapter.verifyAndParse(
    JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { customer: "cus_1" } }),
    new Headers({ "x-signature": "anything" }),
  );
  if (parsed.ok) throw new Error("an unverified payload became a BillingEvent");
  if (parsed.code !== "not_configured") throw new Error(`wrong refusal code: ${parsed.code}`);
});

Deno.test("an unknown provider refuses rather than falling back to manual", () => {
  // Falling back would make an unrecognised provider look identical to a correctly refused
  // event, which is precisely the confusion to avoid when a customer's payment did nothing.
  const resolved = billingAdapterFor("stripe");
  if (resolved.ok) throw new Error("an unregistered provider resolved to an adapter");
  if (resolved.code !== "unsupported") throw new Error(`wrong refusal code: ${resolved.code}`);

  const manual = billingAdapterFor("manual");
  if (!manual.ok) throw new Error("the manual adapter did not resolve");
});

Deno.test("a manual customer id is derived from the organization, never invented", () => {
  // There is no external system filing this customer under another identifier; a random id would
  // create a provider link that resolves to nothing and would then dead-letter every event.
  return manualBillingAdapter
    .createCustomer("51000000-0000-4000-8000-000000000001", "owner@example.test")
    .then((result) => {
      if (!result.ok) throw new Error("the manual adapter refused to name its own customer");
      if (!result.value.customerId.includes("51000000-0000-4000-8000-000000000001")) {
        throw new Error("the manual customer id is not derived from the organization");
      }
    });
});
