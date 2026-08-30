import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Card, ICON, Modal, StatusBadge } from '../components/ui';
import { fmtDate } from '../lib/format';
import { ONBOARDING_SOURCE, ONBOARDING_STEP_STATE } from '../lib/status';
import { setOnboardingStep, type OnboardingStep, type PlatformCapability } from '../lib/platform';
import { reasonOr } from '../lib/reason';

const RECORDABLE = [
  { value: 'in_progress', label: 'בתהליך' },
  { value: 'blocked', label: 'חסום' },
  { value: 'completed', label: 'הושלם (רישום ידני)' },
  { value: 'skipped', label: 'דולג' },
] as const;

/**
 * Onboarding, in the order the brief asks for: what actually happened first, and an operator's
 * assessment only where nothing happened that we can see.
 *
 * A step completed by a product event carries no edit affordance at all. That is not a permission
 * decision — it is that there is nothing to record. The customer imported their suppliers; an
 * operator marking that step "skipped" would be a note the server correctly ignores, and offering
 * the control would invite somebody to write it.
 */
export default function CustomerOnboarding({ orgId, steps, may, busy, run }: {
  orgId: string;
  steps: OnboardingStep[];
  may: (capability: PlatformCapability) => boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>, done: string) => void;
}) {
  const [editing, setEditing] = useState<OnboardingStep | null>(null);

  if (steps.length === 0) return null;
  const done = steps.filter((step) => step.state === 'completed').length;

  return (
    <Card className="space-y-3" as="section" aria-labelledby="onboarding-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="onboarding-heading" className="section-title">הקמה והפעלה</h2>
        <span className="text-sm text-ink-muted num">{done} / {steps.length}</span>
      </div>

      <ul className="divide-y divide-line-soft">
        {steps.map((step) => (
          <li key={step.step_key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="min-w-44 text-sm text-ink-body">{step.label}</span>
            <StatusBadge meta={ONBOARDING_STEP_STATE[step.state]} />
            {step.source !== 'none' && (
              <span className="text-xs text-ink-muted">{ONBOARDING_SOURCE[step.source]}</span>
            )}
            {step.achieved_at && (
              <span className="text-xs text-ink-muted">{fmtDate(step.achieved_at)}</span>
            )}
            {step.reason && (
              <span className="min-w-0 basis-full text-xs text-ink-muted sm:basis-auto">
                {step.reason}
                {step.recorded_by_email ? ` — ${step.recorded_by_email}` : ''}
              </span>
            )}
            {/* Only where the product produced no evidence: a step the customer actually completed
                has nothing for an operator to record. */}
            {may('onboarding.edit') && step.source !== 'product_event' && (
              <button type="button" className="btn-ghost btn-sm ms-auto"
                onClick={() => setEditing(step)}>
                <Pencil size={ICON.xs} aria-hidden="true" /> רישום
              </button>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <StepModal
          busy={busy}
          step={editing}
          onClose={() => setEditing(null)}
          onSubmit={(state, reason) => {
            const target = editing.step_key;
            const targetLabel = editing.label;
            setEditing(null);
            // Recording the step no longer waits for the operator to type anything; when they do
            // not, the ledger says which step was recorded and that nobody added a note.
            run(() => setOnboardingStep({
              orgId, stepKey: target, state,
              reason: reasonOr(reason, `רישום שלב ההקמה ״${targetLabel}״`),
            }), 'השלב נרשם');
          }}
        />
      )}
    </Card>
  );
}

function StepModal({ busy, step, onClose, onSubmit }: {
  busy: boolean;
  step: OnboardingStep;
  onClose: () => void;
  onSubmit: (state: string, reason: string) => void;
}) {
  const [state, setState] = useState<string>(
    step.state === 'not_started' ? 'in_progress' : step.state);
  const [reason, setReason] = useState('');

  return (
    <Modal open onClose={onClose} title={step.label} busy={busy}>
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="step-state">מצב</label>
          <select id="step-state" className="input" value={state}
            onChange={(event) => setState(event.target.value)}>
            {RECORDABLE.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="step-reason">מה ידוע (רשות)</label>
          <textarea id="step-reason" className="input" rows={2} maxLength={1000} value={reason}
            onChange={(event) => setReason(event.target.value)} />
        </div>
        <p className="text-xs text-ink-muted">
          הרישום נשמר ביומן הפלטפורמה. אם השלב יתבצע בפועל במוצר, הפעולה במוצר תגבר על הרישום הזה.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy}
            onClick={() => onSubmit(state, reason)}>שמירה</button>
        </div>
      </div>
    </Modal>
  );
}
