// Shared fetch for the two tools built over public.get_invoice_three_way_match(p_invoice_id)
// (0099, live body carries 0137's payable fence). The RPC is the single computer of every number
// here -- statuses, reasons, tolerances, quantity and price deltas. Nothing in this layer may
// derive a figure the RPC did not return.
import type { ToolEnvelope } from "../../../../src/lib/assistant/contracts.ts";
import type { ToolContext } from "./registry.ts";
import { failure, record } from "./shared.ts";

export interface ThreeWayFetch {
  raw: Record<string, unknown> | null;
  failed: ToolEnvelope | null;
}

export async function fetchThreeWayAssessment(
  ctx: ToolContext,
  invoiceId: string,
): Promise<ThreeWayFetch> {
  const filters = { invoice_id: invoiceId };
  const result = await ctx.db.rpc("get_invoice_three_way_match", {
    p_invoice_id: invoiceId,
  });
  if (result.error) {
    // Only our own vocabulary leaves this boundary. The RPC raises named exceptions
    // (invoice_not_found, invoice_three_way_read_not_authorized); we map them to safe codes and
    // never forward raw database text.
    const message = result.error.message ?? "";
    if (message.includes("invoice_not_found")) {
      return {
        raw: null,
        failed: failure(
          ctx,
          "invoice_not_found",
          "החשבונית לא נמצאה, נמחקה או שאינה בהרשאתך",
          filters,
        ),
      };
    }
    if (message.includes("not_authorized")) {
      return {
        raw: null,
        failed: failure(ctx, "not_permitted", "אין הרשאה לקרוא את החשבונית הזו", filters),
      };
    }
    return {
      raw: null,
      failed: failure(ctx, "three_way_lookup_failed", "בדיקת ההצלבה נכשלה", filters),
    };
  }
  const raw = record(result.data);
  if (!raw) {
    return {
      raw: null,
      failed: failure(
        ctx,
        "three_way_result_malformed",
        "תוצאת בדיקת ההצלבה לא התקבלה במבנה תקין",
        filters,
      ),
    };
  }
  return { raw, failed: null };
}
