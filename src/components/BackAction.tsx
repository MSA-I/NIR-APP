import { ArrowRight } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';

/**
 * One back action for detail, review and multi-step screens (H3).
 *
 * The rule it encodes is about what "back" honestly means. A browser's history entry is only a
 * safe target when we put it there ourselves: `navigate(-1)` from a page someone opened in a new
 * tab, arrived at from an email, or reloaded, walks them out of the application — and on a
 * multi-step flow it walks them into a step they already finished. So history is used ONLY when
 * this navigation stack created the current entry, which react-router records as `location.key`
 * being something other than the initial `'default'`.
 *
 * Otherwise it navigates to the parent list, and it carries the caller's filters with it. Landing
 * on an unfiltered list after reviewing one row of a filtered one is a small thing that costs a
 * person the same three clicks every single time.
 *
 * NOT rendered on dashboards and root lists: a back button that goes nowhere in particular teaches
 * people to stop trusting the one that does.
 */
export function backTarget(
  locationKey: string,
  fallback: string,
  search: string,
): { kind: 'history' } | { kind: 'link'; to: string } {
  // 'default' is react-router's key for an entry this stack did not create — a fresh tab, a
  // reload, a pasted URL. There is no in-app entry behind it to go back to.
  if (locationKey && locationKey !== 'default') return { kind: 'history' };
  return { kind: 'link', to: search ? `${fallback}${search}` : fallback };
}

export function BackAction({ fallback, label, carrySearch = false }: {
  /** The parent list this screen belongs under. Required: there is always a right answer. */
  fallback: string;
  label: string;
  /** Carry the current query string onto the fallback — for a detail screen opened from a filtered list. */
  carrySearch?: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const target = backTarget(location.key, fallback, carrySearch ? location.search : '');

  if (target.kind === 'link') {
    return (
      <Link className="btn-ghost min-h-11" to={target.to}>
        {/* RTL: the arrow points right, which is "back" in a right-to-left reading order. */}
        <ArrowRight size={18} aria-hidden="true" /> {label}
      </Link>
    );
  }
  return (
    <button type="button" className="btn-ghost min-h-11" onClick={() => navigate(-1)}>
      <ArrowRight size={18} aria-hidden="true" /> {label}
    </button>
  );
}
