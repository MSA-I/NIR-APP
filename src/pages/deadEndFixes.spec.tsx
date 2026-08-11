/**
 * G1 — the sentences and the links that `docs/DEAD-ENDS-AUDIT.md` bought.
 *
 * Every finding fixed in this wave is one of three shapes: a sentence that must be true, a link
 * that must exist, or a mechanism that already existed being pointed at a second screen. All three
 * are cheap to write and cheap to lose — a later edit that "tidies" a string or drops a row action
 * puts the dead end straight back, and nothing else in the suite would notice.
 *
 * So the claims are pinned where they can be checked without a database: the pure helpers directly,
 * the rendered copy through the smallest component that owns it. What is NOT here is the browser
 * behaviour of the four screens that need a session (Bank, Reports, Receiving, PayerQueue) — those
 * belong to `npm run quality`, and pretending otherwise with a mock stack deep enough to render
 * them would prove the mock, not the screen.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { quickActionsForPath } from '../components/Fab';
import { quickActionsFor } from '../lib/quickActions';
import { showNavHeaders, sectionsForRole } from '../components/Layout';
import { CategoryDonut } from '../components/charts';
import { toHebrewError } from '../lib/errors';
import {
  DOCUMENT_PROCESSING_STAGE_META,
  DOCUMENT_USER_STATE_META,
  documentUserState,
  type DocumentProcessingStage,
} from '../lib/useDocumentProcessing';

// jsdom implements neither, and every chart goes through ChartViewport (reduced-motion +
// first-viewport animation). Stubbed to the values a browser reports with motion allowed and
// nothing observed, so the donut renders its legend — which is the part under test.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    root = null; rootMargin = ''; thresholds = [];
  } as never;
});

/* ================= finding 7 — the camera at the truck ================= */

describe('finding 7 — the FAB keeps its camera where the user is busiest', () => {
  const SUPPRESSED = ['/orders/new', '/invoices/new', '/receiving/abc-123'];

  it('keeps only the capture action on the three long-form routes', () => {
    for (const path of SUPPRESSED) {
      const actions = quickActionsForPath('office', path);
      expect(actions.map((action) => action.kind)).toEqual(['capture']);
    }
  });

  /**
   * The reason this is a defect and not a preference: /receiving/:orderId is where the kitchen
   * manager stands holding both the goods and the invoice, and the screen itself admitted the
   * camera was gone. Capture navigates nowhere — `QuickCapture` uploads to the inbox and has no
   * `navigate` — so nothing about the suppression's original purpose is given up.
   */
  it('still removes every navigating action there — the form is not at risk', () => {
    for (const path of SUPPRESSED) {
      expect(quickActionsForPath('office', path).some((action) => action.kind === 'link')).toBe(false);
    }
  });

  it('changes nothing anywhere else', () => {
    for (const role of ['owner', 'office', 'accountant'] as const) {
      expect(quickActionsForPath(role, '/dashboard')).toEqual(quickActionsFor(role));
    }
  });

  it('gives a role with no capture action no bar at all, exactly as before', () => {
    // accountant has no `capture` entry in QUICK_ACTIONS, so the filter must empty the bar rather
    // than leave a lone unrelated button on a form route.
    expect(quickActionsForPath('accountant', '/invoices/new')).toEqual([]);
    expect(quickActionsForPath('payer', '/invoices/new')).toEqual([]);
  });
});

/* ================= finding 8 — the correction path that was never ours ================= */

describe('finding 8 — "שכפול כטיוטה" is gone, and nothing replaced it', () => {
  /**
   * The old fix here made the duplicate carry its order and receipt links forward, because dropping
   * them silently emptied `linkedOrderIds` and skipped the whole three-way match block — which on
   * screen is indistinguishable from "all clear".
   *
   * The owner removed the feature on 11.08.2026 rather than the bug: a supplier's invoice is not
   * ours to correct. So the assertion becomes that the entry point cannot come back by accident,
   * which is cheaper to keep true than a link-carrying rule for a route nobody reaches.
   */
  const readPage = (name: string) =>
    readFileSync(join(process.cwd(), 'src', 'pages', name), 'utf8');
  const invoicesSource = readPage('Invoices.tsx');
  const invoiceNewSource = readPage('InvoiceNew.tsx');

  it('offers no duplicate-as-draft action on the invoice list', () => {
    expect(invoicesSource).not.toContain('duplicateInvoiceHref');
    expect(invoicesSource).not.toContain("key: 'duplicate'");
  });

  it('does not prefill the invoice form from another invoice', () => {
    // `?document=` stays: that is a scanned document a person reviewed, not a copy of a record we
    // already hold.
    expect(invoiceNewSource).not.toContain("params.get('from')");
    expect(invoiceNewSource).toContain("params.get('document')");
  });
});

/* ================= finding 12 — the header rule whose premise expired ================= */

describe('finding 12 — no group header over a single grouped link', () => {
  it('shows no headers or destinations to retired product roles', () => {
    for (const role of ['supplier', 'payer', 'kitchen'] as const) {
      const sections = sectionsForRole(role, false);
      expect(sections.flatMap((s) => s.items)).toHaveLength(0);
      expect(showNavHeaders(sections)).toBe(false);
    }
  });

  it('still shows them to every role with a real menu', () => {
    for (const role of ['owner', 'office', 'accountant'] as const) {
      expect(showNavHeaders(sectionsForRole(role, false))).toBe(true);
    }
  });

  /**
   * The regression that reopened it: /dashboard was added for ALL roles and lives in the unnamed
   * leading section, so it lifted supplier and payer over a threshold that counted every item —
   * and the "רכש" header the comment describes started rendering over a vendor's own price list.
   * Counting named sections only is what makes the rule immune to that.
   */
  it('is not moved by the unnamed leading section', () => {
    const accountant = sectionsForRole('accountant', false);
    expect(accountant[0]?.section).toBe('');
    expect(showNavHeaders(accountant)).toBe(true);
  });
});

/* ================= finding 13 — four labels become four destinations ================= */

describe('finding 13 — the accountant can open a supplier balance', () => {
  const slices = [
    { name: 'ירקות השדה', total: 4000 },
    { name: 'אחר', total: 1000 },
  ];

  const renderDonut = (hrefFor?: (slice: { name: string; total: number }) => string | null) => render(
    <MemoryRouter>
      <CategoryDonut slices={slices} total={5000} ariaLabel="יתרות" emptyMessage="אין" hrefFor={hrefFor} />
    </MemoryRouter>,
  );

  it('links a named slice and leaves the aggregate alone', () => {
    renderDonut((slice) => (slice.name === 'אחר' ? null : `/invoices?q=${encodeURIComponent(slice.name)}&pay=open`));

    const link = screen.getByRole('link', { name: 'ירקות השדה' });
    expect(link).toHaveAttribute('href', '/invoices?q=%D7%99%D7%A8%D7%A7%D7%95%D7%AA%20%D7%94%D7%A9%D7%93%D7%94&pay=open');
    // "אחר" is several suppliers summed. A link that lands on one wrong filter is worse than none.
    expect(screen.queryByRole('link', { name: 'אחר' })).toBeNull();
    expect(screen.getByText('אחר')).toBeInTheDocument();
  });

  it('renders no links at all for the callers that pass nothing', () => {
    renderDonut();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('ירקות השדה')).toBeInTheDocument();
  });

  it('keeps the money and the share on the row that became a link', () => {
    renderDonut((slice) => (slice.name === 'אחר' ? null : '/invoices'));
    const link = screen.getByRole('link', { name: 'ירקות השדה' });
    expect(within(link).getByText('80%')).toBeInTheDocument();
  });
});

/* ================= finding 5 — the advice that could not help ================= */

describe('finding 5 — the receipt error names the constraint instead of suggesting a refresh', () => {
  const message = toHebrewError(new Error('receipt_qty_exceeds_order'));

  it('no longer tells the user to refresh', () => {
    // `save_goods_receipt` raises this for a row count mismatch, an unknown order item, an
    // over-remaining quantity and a status/quantity disagreement. A refresh addresses none of them.
    expect(message).not.toContain('רענן');
  });

  it('says what a receipt may contain, which is the only actionable fact', () => {
    expect(message).toContain('שורות ההזמנה');
    expect(message).toContain('לא הוזמן');
  });
});

describe('retired identities — reassignment cannot look half successful', () => {
  it('routes the owner to the platform operator instead of leaking the database code', () => {
    const message = toHebrewError(new Error('retired_identity_requires_platform_reactivation'));
    expect(message).toContain('מנהל השירות');
    expect(message).toContain('חסימת הכניסה');
    expect(message).not.toContain('retired_identity');
  });
});

/* ================= finding 20 — one document, one vocabulary ================= */

describe('finding 20 — the everyday surfaces speak the four human states', () => {
  const STAGES = Object.keys(DOCUMENT_PROCESSING_STAGE_META) as DocumentProcessingStage[];

  /**
   * `AttachmentsPanel`, `FileUpload` and the `registered` branch of `UploadCenter` all render
   * `DOCUMENT_USER_STATE_META[documentUserState(stage)]`. Pinning the mapping is what makes the
   * three call sites' single-line change checkable without mounting three screens; the browser
   * gate already scans the documents folder itself for pipeline words.
   */
  it('maps every pipeline stage onto a word a person can act on', () => {
    const human = new Set(Object.values(DOCUMENT_USER_STATE_META).map(({ label }) => label));
    const engineering = new Set(Object.values(DOCUMENT_PROCESSING_STAGE_META).map(({ label }) => label));
    for (const stage of STAGES) {
      const label = DOCUMENT_USER_STATE_META[documentUserState(stage)].label;
      expect(human).toContain(label);
      // "ממתין לפירוש" was the exact word appearing one click from "נקלט" on the same document.
      expect(engineering.has(label)).toBe(false);
    }
  });

  /**
   * The audit's own correction, and the reason `UploadCenter` was not folded in wholesale:
   * `unprocessed` collapses into `intake` — the same "נקלט" a queued document gets — so on an
   * upload surface, where "registered but never sent to be read" is the one distinction that
   * matters, that stage must keep its own answer. `displayMeta` excludes it for exactly this.
   */
  it('cannot distinguish "never sent to be read" from "being read" — which is why UploadCenter keeps its own branch', () => {
    expect(documentUserState('unprocessed')).toBe(documentUserState('queued'));
  });
});
