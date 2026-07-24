import type { ReactNode } from 'react';

/**
 * Shared frame for the per-role control rooms. Mirrors the owner dashboard's page shell (title +
 * action row, then stacked content) so every role reads as the same product, only scoped to its data.
 */
export function DashboardFrame({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="dashboard-depth space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">{title}</h1>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** A titled card that houses one chart — the role equivalent of the owner "מגמות" section header. */
export function ChartCard({ title, subtitle, className, children }: {
  title: string; subtitle?: string; className?: string; children: ReactNode;
}) {
  return (
    <section className={`card overflow-hidden ${className ?? ''}`}>
      <div className="px-4 pt-4 sm:px-5">
        <h2 className="section-title">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
      </div>
      <div className="px-4 pb-4 pt-1 sm:px-5">{children}</div>
    </section>
  );
}
