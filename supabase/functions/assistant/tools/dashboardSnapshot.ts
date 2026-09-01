// Shared fetch for public.management_dashboard_snapshot(p_today) (0100, patched in place by
// 0137 -- payable fence -- and 0148 -- due-window money). p_today is ALWAYS computed here as the
// current business day in Asia/Jerusalem; unlike the app's own Dashboard it is never taken from
// the browser. The function is SECURITY INVOKER and returns NULL for any role other than
// owner/office -- a null result is a refusal, never an empty measurement.
import type { ToolEnvelope } from "../../../../src/lib/assistant/contracts.ts";
import { toZoneISO } from "../time.ts";
import type { ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import { failure, record } from "./shared.ts";

export interface SnapshotFetch {
  snapshot: Record<string, unknown> | null;
  businessDate: string;
  failed: ToolEnvelope | null;
}

export async function fetchDashboardSnapshot(
  ctx: ToolContext,
): Promise<SnapshotFetch> {
  const businessDate = toZoneISO(ctx.now());
  const filters = { business_date: businessDate };
  const result = await ctx.db.rpc("management_dashboard_snapshot", {
    p_today: businessDate,
  });
  if (result.error) {
    return {
      snapshot: null,
      businessDate,
      failed: failure(
        ctx,
        "dashboard_snapshot_failed",
        readerText(ctx.locale, "assistantTools.dashboardFetchFailed"),
        filters,
      ),
    };
  }
  const snapshot = record(result.data);
  if (!snapshot) {
    // The role gate inside the function answered null. requiredRoles should have prevented the
    // call; if it still happens the honest answer is a named refusal, never a clean zero sheet.
    return {
      snapshot: null,
      businessDate,
      failed: failure(
        ctx,
        "not_permitted",
        readerText(ctx.locale, "assistantTools.dashboardOwnerOfficeOnly"),
        filters,
      ),
    };
  }
  return { snapshot, businessDate, failed: null };
}
