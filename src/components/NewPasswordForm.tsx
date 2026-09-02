import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Card, ICON } from './ui';
import { useT } from '../lib/i18n/LocaleProvider';
import { MIN_PASSWORD_LENGTH, passwordProblemOf } from '../lib/password';

/**
 * The two boxes that choose a password, extracted because there are now two screens that do it.
 *
 * `/reset-password` has asked this question since #114. `/set-password` asks the same one, for the
 * opposite reason: owner ruling #332 means a self-signup account is created WITHOUT a password, so
 * the first one is chosen after the address is confirmed rather than before. Same rule, same
 * validation, same wording — and a second copy of it is how the two would drift until one of them
 * accepted a password the other refused.
 *
 * The parent owns the network call and whatever the server said about it; this owns the pair and
 * the local judgement on it. `passwordProblemOf` judges the PAIR, which is why both boxes carry
 * `aria-invalid` and both point at one message: naming one of them would be a claim the check does
 * not make.
 */
export interface NewPasswordFormProps {
  /** Distinguishes the input ids when two of these ever coexist; also names the error region. */
  idPrefix: string;
  busy: boolean;
  /** A refusal from the server. The local one wins while it stands — it is the newer judgement. */
  error: string | null;
  submitLabel: string;
  onValidPassword: (password: string) => void;
  /** Called on every keystroke so the parent can clear a stale server refusal. */
  onEdit?: () => void;
}

export default function NewPasswordForm(props: NewPasswordFormProps) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const shown = localError ?? props.error;
  const problemId = shown ? `${props.idPrefix}-problem` : undefined;

  function edit(apply: (value: string) => void, value: string) {
    apply(value);
    setLocalError(null);
    props.onEdit?.();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblemOf(password, confirm);
    setLocalError(problem && t(problem.key, problem.vars));
    if (problem) return;
    props.onValidPassword(password);
  }

  return (
    <Card as="form" onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor={`${props.idPrefix}-new`}>
          {t('resetPasswordTail.newPasswordLabel', { min: MIN_PASSWORD_LENGTH })}
        </label>
        <input id={`${props.idPrefix}-new`} type="password" className="input" dir="ltr"
          autoComplete="new-password" value={password}
          aria-invalid={shown ? true : undefined}
          aria-describedby={problemId}
          onChange={(event) => edit(setPassword, event.target.value)} required />
      </div>
      <div>
        <label className="label" htmlFor={`${props.idPrefix}-confirm`}>
          {t('resetPasswordTail.confirmPassword')}
        </label>
        <input id={`${props.idPrefix}-confirm`} type="password" className="input" dir="ltr"
          autoComplete="new-password" value={confirm}
          aria-invalid={shown ? true : undefined}
          aria-describedby={problemId}
          onChange={(event) => edit(setConfirm, event.target.value)} required />
      </div>
      {shown && <div id={problemId} role="alert" className="text-sm text-alert-fg">{shown}</div>}
      <button type="submit" className="btn-primary w-full" disabled={props.busy || !password || !confirm}>
        {props.busy
          ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
          : <KeyRound size={ICON.sm} aria-hidden="true" />}
        {props.submitLabel}
      </button>
    </Card>
  );
}
