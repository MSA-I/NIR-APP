// Business-day arithmetic, mirroring src/lib/format.ts (todayISO/addCalendarDays) so the
// assistant's windows land on the same calendar days the product's own screens use. The zone is
// the contracts' ORG_TIME_ZONE -- one opinion, not a second one.
import { ORG_TIME_ZONE } from "../../../src/lib/assistant/contracts.ts";

export function toZoneISO(date: Date, timeZone = ORG_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function addCalendarDays(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Invalid date: expected YYYY-MM-DD");
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  return shifted.toISOString().slice(0, 10);
}
