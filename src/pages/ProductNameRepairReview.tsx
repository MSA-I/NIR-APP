import { useT } from '../lib/i18n/LocaleProvider';
import { useRef, useState } from 'react';
import { AlertTriangle, Check, FileSpreadsheet, LockKeyhole } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { reasonOr } from '../lib/reason';
import { Card, ICON, SubPanel, useToast } from '../components/ui';
import type { TKey } from '../lib/i18n/t';

/**
 * Named in the audit row; `reasonOr` completes the sentence when nobody typed one.
 *
 * This screen renders directly above `ProductNameReview` on `/products`, and that file's
 * `WHY NO DIALOG DEMANDS A TYPED REASON` states the owner's ruling for exactly this queue:
 * approving a queued proposal is the ordinary forward step, repeated row after row, and a box
 * that blocks the button produces "asdf" rather than reasons. A required box here contradicted
 * its sibling on the same screen, so it is gone. **Do not restore it** — the row already carries
 * its own evidence (old name, source file, row, SHA-256), which is the part that makes the
 * approval explicable a year later; the ledger keeps a truthful sentence either way.
 */
const APPROVE_ACTION = 'אישור תיקון שם מוצר ממקור';

export interface ProductNameRepairCandidate {
  candidate_id: string;
  product_id: string;
  status: 'ready' | 'blocked' | 'unchanged';
  reason_code: 'missing_source' | 'ambiguous_source' | 'source_name_missing' | 'source_same_as_current' | null;
  old_name: string;
  proposed_name: string | null;
  source_submission_id: string;
  source_file_name: string;
  source_checksum: string;
  source_row: number | null;
  source_evidence: Record<string, unknown>;
}

const REASON_KEY: Record<NonNullable<ProductNameRepairCandidate['reason_code']>, TKey> = {
  missing_source: 'productNameRepair.reasonMissingSource',
  ambiguous_source: 'productNameRepair.reasonAmbiguousSource',
  source_name_missing: 'productNameRepair.reasonSourceNameMissing',
  source_same_as_current: 'productNameRepair.reasonSourceSameAsCurrent',
};

/** What `get_product_name_repair_queue` answers: the queue, and whether it was ever measured. */
export interface ProductNameRepairQueue {
  has_dry_run: boolean;
  dry_run_count: number;
  latest_dry_run_at: string | null;
  candidates: ProductNameRepairCandidate[];
}

export function ProductNameRepairReview({ queue, dryRunProduced, onApplied }: {
  queue: ProductNameRepairCandidate[] | null;
  /**
   * `false` when no dry-run report has ever been produced for this organization, `null` while that
   * is unknown. An empty queue under `false` is not a finished backlog — it is an unmeasured one,
   * and the screen may not render it as a zero.
   */
  dryRunProduced: boolean | null;
  onApplied: (candidateId: string) => void;
}) {
  const { t } = useT();
  if (queue === null || dryRunProduced === null) {
    return <div className="note-idle" role="status">{t('productNameRepair.text')}</div>;
  }
  if (!dryRunProduced) {
    return (
      <div className="note-idle" role="status">
        <AlertTriangle size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {t('productNameRepair.text_2')}
        </span>
      </div>
    );
  }
  if (queue.length === 0) {
    return <div className="note-done" role="status"><Check size={ICON.sm} aria-hidden="true" />{t('productNameRepair.text_3')}</div>;
  }
  return (
    <section className="space-y-4" aria-labelledby="source-name-repair-heading">
      <div className="space-y-2">
        <h2 id="source-name-repair-heading" className="text-lg font-semibold text-ink">{t('productNameRepair.text_4')}</h2>
        <p className="text-sm text-ink-soft">
          {t('productNameRepair.text_5')}
        </p>
      </div>
      <ul className="space-y-3">
        {queue.map((candidate) => (
          <RepairCard key={candidate.candidate_id} candidate={candidate} onApplied={onApplied} />
        ))}
      </ul>
    </section>
  );
}

function RepairCard({ candidate, onApplied }: {
  candidate: ProductNameRepairCandidate;
  onApplied: (candidateId: string) => void;
}) {
  const { errorText, t } = useT();
  const toast = useToast();
  // One command identity per candidate card. A failed response must replay the same command,
  // otherwise the server cannot distinguish retry from a second approval attempt.
  const idempotencyKey = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const ready = candidate.status === 'ready' && candidate.proposed_name !== null;
  const evidence = Object.entries(candidate.source_evidence)
    .filter(([, value]) => value != null && String(value).trim() !== '');

  async function apply() {
    setBusy(true);
    const result = await supabase.rpc('apply_product_name_repair', {
      p_candidate_id: candidate.candidate_id,
      p_expected_old_name: candidate.old_name,
      p_expected_proposed_name: candidate.proposed_name,
      p_expected_source_checksum: candidate.source_checksum,
      p_idempotency_key: idempotencyKey.current,
      p_reason: reasonOr(null, APPROVE_ACTION),
    });
    setBusy(false);
    if (result.error) { toast(errorText(result.error.message), 'error'); return; }
    toast(t('productNameRepair.toast_2'));
    onApplied(candidate.candidate_id);
  }

  return (
    <Card as="li" className="space-y-4" data-testid={`repair-${candidate.candidate_id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-ink-muted">{t('productNameRepair.text_6')}</p>
          <p className="break-words text-sm text-ink-mid"><bdi>{candidate.old_name}</bdi></p>
        </div>
        <span className={ready ? 'badge-await' : candidate.status === 'unchanged' ? 'badge-done' : 'badge-idle'}>
          {ready ? t('productNameRepair.text_7') : candidate.status === 'unchanged' ? t('productNameRepair.text_8') : t('productNameRepair.text_9')}
        </span>
      </div>

      {candidate.proposed_name && (
        <SubPanel>
          <p className="text-xs text-ink-muted">{t('productNameRepair.text_10')}</p>
          <p className="mt-1 break-words font-medium text-ink"><bdi>{candidate.proposed_name}</bdi></p>
        </SubPanel>
      )}

      <div className="note-idle items-start">
        <FileSpreadsheet size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1 text-sm">
          <p><span className="font-medium">{t('productNameRepair.text_11')}</span> <bdi>{candidate.source_file_name}</bdi>
            {candidate.source_row != null && <> {t('productNameRepair.text_12')} <span className="num">{candidate.source_row}</span></>}</p>
          {evidence.length > 0 && <p>{evidence.map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</p>}
          <p className="break-all text-xs text-ink-muted" dir="ltr" title={candidate.source_checksum}>
            SHA-256 {candidate.source_checksum.slice(0, 12)}…
          </p>
        </div>
      </div>

      {!ready ? (
        <div className="note-await items-start">
          {candidate.status === 'unchanged'
            ? <LockKeyhole size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
            : <AlertTriangle size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />}
          <p>{candidate.reason_code ? t(REASON_KEY[candidate.reason_code]) : t('productNameRepair.text_13')}</p>
        </div>
      ) : (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void apply()}>
          <Check size={ICON.sm} aria-hidden="true" /> {t('productNameRepair.approveRepair')}
          </button>
      )}
    </Card>
  );
}
