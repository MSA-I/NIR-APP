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

/**
 * Pure data mapping — the unit-testable half of the render.
 *
 * `name` is the RAW catalogue name, deliberately. This image is sent to the supplier, who picks
 * the goods by their own wording; see the `WhatsAppOrder` docblock in ./share.ts and `productLabel`
 * in ./format.ts. `productLabel.spec.ts` fails the build if this file ever reaches for it.
 */
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
      // Hebrew on purpose: the image goes to the supplier, like the name beside it. See share.ts.
      qty: formatQuantity(item.qty, item.product.unit, 'he'),
      sku: item.product.sku,
    })),
  };
}

export function orderImageFileName(order: WhatsAppOrder): string {
  return `order-${order.number}.png`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The order as one picture, in the document system (#330).
 *
 * SAME FAMILY AS THE PDF AND THE EMAIL. This image and the order sheet are the same document in
 * three frames, so it opens on the same onyx plate with the same eyebrow and the same filled table
 * head. What a supplier gets on WhatsApp and what they get as a PDF now read as one business.
 *
 * The eyebrow keeps its latin half for the reason the @font-face note gives: the mono carries no
 * Hebrew, so a Hebrew-only line would never actually be drawn in it.
 *
 * STILL NO PRICES, and that is unchanged and deliberate (owner decision 18.08.2026). The image
 * travels to the supplier; pricing stays out of the whole export.
 */
function templateMarkup(model: OrderImageModel): string {
  const cell = 'padding:11px 14px;border-bottom:1px solid var(--color-doc-line)';
  const num = 'font-variant-numeric:tabular-nums lining-nums;unicode-bidi:isolate';
  const head = 'padding:11px 14px;text-align:start;font-weight:500;font-size:13px;'
    + 'letter-spacing:0.06em;color:var(--color-doc-ink)';
  const meta = [
    `ספק: <bdi>${esc(model.supplierName)}</bdi>`,
    ...(model.expectedDate ? [`אספקה מבוקשת: ${esc(model.expectedDate)}`] : []),
    `הופק: ${esc(model.generatedAt)}`,
  ].join(' · ');
  const rows = model.rows.map((row, i) => `
    <tr style="background:${i % 2 ? 'var(--color-doc-paper-sink)' : 'var(--color-doc-paper)'}">
      <td style="${cell};${num};color:var(--color-doc-ink-muted)">${row.index}</td>
      <td style="${cell};font-weight:500;color:var(--color-doc-ink-body)"><bdi>${esc(row.name)}</bdi></td>
      <td style="${cell};${num};white-space:nowrap;font-weight:600;color:var(--color-doc-plate)">${esc(row.qty)}</td>
      <td style="${cell};${num};direction:ltr;text-align:end;color:var(--color-doc-ink-muted);font-family:var(--font-doc-mono)">${row.sku ? esc(row.sku) : '—'}</td>
    </tr>`).join('');
  return `
    <div style="background:var(--color-doc-plate);color:var(--color-doc-ink);border-radius:var(--radius-doc-plate);padding:26px 30px 24px;margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px">
        <span style="font-family:var(--font-doc-mono);font-size:12px;font-weight:600;letter-spacing:0.18em;color:var(--color-doc-accent-lift)">רכש · PURCHASE</span>
        <span style="font-size:14px;color:var(--color-doc-ink-dim)"><bdi>${esc(model.orgName)}</bdi></span>
      </div>
      <div style="font-family:var(--font-doc-display);font-weight:800;font-size:40px;line-height:1;letter-spacing:-0.032em;margin-top:20px;${num}">${esc(model.title)}</div>
      <div style="font-size:14px;color:var(--color-doc-ink-soft);margin-top:12px">${meta}</div>
    </div>
    ${model.notes ? `<div style="font-size:15px;color:var(--color-doc-ink-body);background:var(--color-doc-paper-sink);border-radius:10px;padding:14px 18px;margin-bottom:18px">הערות: <bdi>${esc(model.notes)}</bdi></div>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:16px">
      <thead>
        <tr style="background:var(--color-doc-plate)">
          <th style="${head};width:40px">#</th>
          <th style="${head}">פריט</th>
          <th style="${head}">כמות</th>
          <th style="${head}">מק״ט</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:18px;display:flex;justify-content:space-between;align-items:center;font-size:14px;color:var(--color-doc-ink-muted)">
      <span>סה״כ פריטים: <span style="${num}">${model.rows.length}</span></span>
      <span>התמונה אינה כוללת מחירים — במכוון.</span>
    </div>`;
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
    'background:var(--color-doc-paper)', 'color:var(--color-doc-plate)',
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
