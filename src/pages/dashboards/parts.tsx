import type { ReactNode } from 'react';
import { PageHeader } from '../../components/ui';

/**
 * Shared frame for the per-role control rooms. Mirrors the owner dashboard's page shell (title +
 * action row, then stacked content) so every role reads as the same product, only scoped to its data.
 */
export function DashboardFrame({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="dashboard-depth space-y-5">
      <PageHeader title={title} actions={actions} />
      {children}
    </div>
  );
}

/**
 * A titled region that houses one chart — the role equivalent of the owner "מגמות" board.
 *
 * No longer a card (density round, 18.08.2026), for the same reason the owner's trends board
 * stopped being one: a heading and a hairline already say "one board, one subject", and a border
 * plus a radius plus a dashboard shadow around every chart turned a three-chart control room into
 * three floating panels with nothing to rank them. On a phone the card also cost 32px of gutter
 * that the chart itself could use. The heading, the qualifier and the chart are unchanged.
 *
 * The name is kept because `AccountantDashboard.tsx` — this component's only consumer — is outside
 * this round's file scope; it wants renaming to `ChartRegion` with that call site.
 */
export function ChartCard({ title, subtitle, className, children }: {
  title: string; subtitle?: string; className?: string; children: ReactNode;
}) {
  return (
    <section className={className}>
      <h2 className="section-title">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
      <div className="mt-2 border-t border-line-soft pt-3">{children}</div>
    </section>
  );
}
