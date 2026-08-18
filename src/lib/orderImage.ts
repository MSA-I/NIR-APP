import { fmtDate, formatQuantity } from './format';
import type { WhatsAppOrder } from './share';

/**
 * The second of the two WhatsApp messages: the order as one PNG, rendered from a fixed template.
 *
 * Built once in code and filled per order (owner decision 18.08.2026) — system colors, all line
 * items, and NO prices anywhere: the image travels to the supplier, and pricing stays out of the
 * whole export (the text message dropped its total in the same decision).
 *
 * Rendering rides an offscreen DOM node + html2canvas-pro — the browser's own layout engine is
 * what gets Hebrew shaping, bidi runs and dynamic height (10–60 rows) right; hand-drawing that
 * on a canvas would re-implement all three. `html2canvas-pro`, NOT `html2canvas`: the original
 * throws on the oklch color tokens Tailwind v4 emits (measured — see src/lib/screenshot.ts).
 * Dynamic import for the same reason screenshot.ts uses one: most sessions never render this.
 */

export interface OrderImageModel {
  title: string;
  orgName: string;
  supplierName: string;
  expectedDate: string | null; // formatted; null = the row is omitted, never a fake value
  generatedAt: string;
  notes: string | null;
  rows: { index: number; name: string; qty: string; sku: string | null }[];
}

/** Pure data mapping — the unit-testable half of the render. */
export function orderImageModel(order: WhatsAppOrder, orgName: string): OrderImageModel {
  return {
    title: `הזמנת רכש #${order.number}`,
    orgName,
    supplierName: order.supplier.name,
    expectedDate: order.expected_date ? fmtDate(order.expected_date) : null,
    generatedAt: fmtDate(new Date().toISOString()),
    notes: order.notes,
    rows: order.items.map((item, i) => ({
      index: i + 1,
      name: item.product.name,
      qty: formatQuantity(item.qty, item.product.unit),
      sku: item.product.sku,
    })),
  };
}

export function orderImageFileName(order: WhatsAppOrder): string {
  return `order-${order.number}.png`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Quiet-control-room table: token colors, hairline separators, soft zebra — no decoration. */
function templateMarkup(model: OrderImageModel): string {
  const meta = [
    `ספק: <bdi>${esc(model.supplierName)}</bdi>`,
    ...(model.expectedDate ? [`אספקה מבוקשת: ${esc(model.expectedDate)}`] : []),
    `הופק: ${esc(model.generatedAt)}`,
  ].join(' · ');
  const rows = model.rows.map((row, i) => `
    <tr style="background:${i % 2 ? 'var(--color-surface-sunken)' : 'var(--color-surface)'}">
      <td style="padding:8px 12px;border-bottom:1px solid var(--color-line-soft);font-variant-numeric:tabular-nums;unicode-bidi:isolate;color:var(--color-ink-muted)">${row.index}</td>
      <td style="padding:8px 12px;border-bottom:1px solid var(--color-line-soft);font-weight:500;color:var(--color-ink-body)"><bdi>${esc(row.name)}</bdi></td>
      <td style="padding:8px 12px;border-bottom:1px solid var(--color-line-soft);font-variant-numeric:tabular-nums;unicode-bidi:isolate;white-space:nowrap">${esc(row.qty)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid var(--color-line-soft);font-variant-numeric:tabular-nums;unicode-bidi:isolate;direction:ltr;text-align:end;color:var(--color-ink-muted)">${row.sku ? esc(row.sku) : '—'}</td>
    </tr>`).join('');
  return `
    <div style="background:var(--color-surface-sunken);border-inline-start:4px solid var(--color-action);border-radius:10px;padding:20px 24px;margin-bottom:20px">
      <div style="font-size:15px;color:var(--color-ink-muted);margin-bottom:4px"><bdi>${esc(model.orgName)}</bdi></div>
      <div style="font-size:24px;font-weight:700;color:var(--color-ink);font-variant-numeric:tabular-nums">${esc(model.title)}</div>
      <div style="font-size:14px;color:var(--color-ink-muted);margin-top:8px">${meta}</div>
    </div>
    ${model.notes ? `<div style="font-size:14px;color:var(--color-ink-body);background:var(--color-surface-sunken);border-radius:8px;padding:12px 16px;margin-bottom:16px">הערות: <bdi>${esc(model.notes)}</bdi></div>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <thead>
        <tr style="background:var(--color-surface-sunken)">
          <th style="padding:8px 12px;text-align:start;color:var(--color-ink-muted);font-weight:600;border-bottom:1px solid var(--color-line-soft)">#</th>
          <th style="padding:8px 12px;text-align:start;color:var(--color-ink-muted);font-weight:600;border-bottom:1px solid var(--color-line-soft)">פריט</th>
          <th style="padding:8px 12px;text-align:start;color:var(--color-ink-muted);font-weight:600;border-bottom:1px solid var(--color-line-soft)">כמות</th>
          <th style="padding:8px 12px;text-align:start;color:var(--color-ink-muted);font-weight:600;border-bottom:1px solid var(--color-line-soft)">מק״ט</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:16px;font-size:14px;color:var(--color-ink-muted)">סה״כ פריטים: <span style="font-variant-numeric:tabular-nums;unicode-bidi:isolate">${model.rows.length}</span></div>`;
}

/** Renders the order image and resolves to a PNG blob. Throws a Hebrew error on failure. */
export async function renderOrderImage(order: WhatsAppOrder, orgName: string): Promise<Blob> {
  const host = document.createElement('div');
  host.setAttribute('dir', 'rtl');
  host.setAttribute('lang', 'he');
  // data-no-capture: the feedback screenshot must never photograph this staging node.
  host.setAttribute('data-no-capture', '');
  // Physical `top` on purpose — vertical offsets are direction-safe, so the logical-properties
  // rule is about inline (start/end) axes and this stays out of its way.
  host.style.cssText = [
    'position:fixed', 'top:-10000px', 'inset-inline-start:0', 'width:800px',
    'background:var(--color-surface)', 'color:var(--color-ink)',
    "font-family:var(--font-sans, 'Noto Sans Hebrew', sans-serif)",
    'padding:32px', 'box-sizing:border-box',
  ].join(';');
  host.innerHTML = templateMarkup(orderImageModel(order, orgName));
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    const { default: html2canvas } = await import('html2canvas-pro');
    // scale 2: crisp on retina and deterministic across devices (not devicePixelRatio).
    const canvas = await html2canvas(host, { scale: 2, backgroundColor: null, logging: false, useCORS: true });
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    if (!blob || blob.size === 0) throw new Error('empty');
    return blob;
  } catch {
    throw new Error('לא ניתן היה להפיק את תמונת ההזמנה');
  } finally {
    host.remove();
  }
}
