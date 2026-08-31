import type { ReactNode } from 'react';
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';

/**
 * The block every generated document opens with (#309).
 *
 * ONE COMPONENT FOR FOUR SURFACES. The order sheet, the invoice card, the expense summary and the
 * monthly report each grew their own `print-only` heading, and the four had drifted: three sizes
 * of logo, three ways of writing the org name, one of them with the document type hardcoded in
 * Hebrew. A supplier who receives an order and an accountant who receives the month were looking
 * at two products. This is that heading, once.
 *
 * IT ONLY EXISTS ON PAPER. Callers render it inside `.print-only`, so the browser never shows it;
 * `@media print` and the `.pdf-capture` class are the two contexts that do. That is also why the
 * document vocabulary — Heebo at 800, the mono eyebrow, the plate colours — can differ from the screens'
 * without either one leaking into the other.
 *
 * ─── WHAT THE READER USES TO TELL TWO DOCUMENTS APART ────────────────────────────────────────
 * `family` decides both signals at once, and that is deliberate: a caller that passed the plate
 * and the ink separately would eventually pass a light ink onto a light plate, and the failure
 * would be invisible until it was on a customer's desk. The plate variant sets `--doc-on-plate`
 * in CSS and everything inside reads it.
 *
 *   purchase → the onyx plate. Goes to a supplier and has to be caught.
 *   payment  → the filled teal plate. Money that came in; goes to the paying customer.
 *   ledger   → paper with a hairline. A record that stays in the business's own file.
 *   report   → the sunken sheet. A periodic summary; a folder of them reads as a series.
 *
 * THE EYEBROW IS TEXT, NOT A COLOUR CODE. It names the family in words, so the distinction
 * survives a grayscale printer, a colour-blind reader and a thumbnail. In Hebrew it carries the
 * latin half too (`רכש · PURCHASE`) — the mono has no Hebrew glyphs at all, so without a latin
 * run the face would never actually be painted on a Hebrew document and the two editions would be
 * set in two different typographic systems. The English dictionary needs no such pairing.
 *
 * ─── THE MARK, AND WHOSE IT IS ───────────────────────────────────────────────────────────────
 * `orgLogoUrl` wins when the tenant has uploaded one: on their purchase order, their supplier
 * should see THEM. It is never recoloured — it is theirs, and an unknown logo on an unknown
 * ground is exactly what `.doc-org-logo`'s paper backing exists for. Falling back, the InPlace
 * lockup is drawn in a SINGLE ink chosen by the plate (owner ruling 31.08.2026): there is no
 * coloured lockup inside a document, so the mark can never land light-on-light.
 *
 * NOT IMPLEMENTED HERE, ON PURPOSE: whether the tenant is ENTITLED to replace the mark. Today the
 * logo shows whenever one is uploaded, which is the behaviour that already shipped. `#309` states
 * the intended end state — replacement belongs to `exports.unbranded_pdf` — and reaching it needs
 * the entitlement at render time, where today it is only asked for at download time
 * (`exportWatermark()`). That is a behaviour change and does not belong in a design change.
 */

export type DocumentFamily = 'purchase' | 'payment' | 'ledger' | 'report';

const PLATE_CLASS: Record<DocumentFamily, string> = {
  purchase: '',
  payment: 'doc-plate-action',
  ledger: 'doc-plate-paper',
  report: 'doc-plate-sink',
};

const EYEBROW_KEY: Record<DocumentFamily, TKey> = {
  purchase: 'docPlate.eyebrowPurchase',
  payment: 'docPlate.eyebrowPayment',
  ledger: 'docPlate.eyebrowLedger',
  report: 'docPlate.eyebrowReport',
};

/** A dark plate takes the paper-toned mark; the two light plates take the ink one. */
const MARK_SRC: Record<DocumentFamily, string> = {
  purchase: '/brand/inplace-lockup-paper-mono.svg',
  payment: '/brand/inplace-lockup-paper-mono.svg',
  ledger: '/brand/inplace-lockup-ink.svg',
  report: '/brand/inplace-lockup-ink.svg',
};

export interface DocumentPlateProps {
  family: DocumentFamily;
  /** The document's own name, at the largest size on the page. */
  name: string;
  /** The identifying number, set in the mono. Absent for a document that has none. */
  number?: string | null;
  /** One line under the name. Absent rather than empty when there is nothing to say. */
  subtitle?: string | null;
  orgLogoUrl?: string | null;
  /** Anything that belongs under the number — a state chip, a version, a lock. */
  meta?: ReactNode;
  /** `compact` for the landscape report, where the page is wide and the grid is the point. */
  size?: 'default' | 'compact';
}

export function DocumentPlate({
  family, name, number, subtitle, orgLogoUrl, meta, size = 'default',
}: DocumentPlateProps) {
  const { t } = useT();
  const compact = size === 'compact';

  return (
    <div className={`doc-plate ${PLATE_CLASS[family]}`}>
      {/* Carries the two lower registration corners; the plate's own ::before/::after carry the
          upper two. A pseudo-element cannot be given a third and fourth position. */}
      <span className="doc-crop" aria-hidden="true" />

      <div className="flex items-center justify-between gap-6">
        <p className="doc-eyebrow">{t(EYEBROW_KEY[family])}</p>
        <span className="doc-mark">
          {orgLogoUrl
            ? <img data-testid="document-org-logo" src={orgLogoUrl} alt="" className="doc-org-logo h-8 w-auto max-w-40 object-contain" />
            : <img src={MARK_SRC[family]} alt="" className="h-5 w-auto" />}
        </span>
      </div>

      <div className={`flex items-end justify-between gap-6 ${compact ? 'mt-4' : 'mt-7'}`}>
        <div className="min-w-0">
          <h2 className={`doc-name ${compact ? 'text-[2.5rem]' : ''}`}>{name}</h2>
          {subtitle && <div className="doc-sub">{subtitle}</div>}
        </div>
        {(number || meta) && (
          <div className="flex shrink-0 flex-col items-end gap-2">
            {number && <span className="doc-mono text-[0.8125rem] font-medium">{number}</span>}
            {meta}
          </div>
        )}
      </div>
    </div>
  );
}
