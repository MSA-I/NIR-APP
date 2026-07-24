import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A filter value seeded from a URL query param that RE-SYNCS when the param changes.
 *
 * `useState(params.get('x'))` reads the param once, on mount only. The dashboard is now a
 * navigation hub that fires many links at the *same* route with different params (e.g.
 * `/exceptions?status=open` and then `/exceptions?status=open&severity=high`). React Router
 * keeps the target component mounted across those navigations, so a plain `useState` seed
 * silently ignores every navigation after the first — the screen would not re-filter.
 *
 * The URL is the source of truth: the setter writes only its owned parameter (with replace,
 * so filter edits do not spam history) and preserves every unrelated deep-link parameter.
 * Back/Forward and same-route navigation therefore re-render from the current URL directly.
 *
 * Intended to replace `useState(params.get(name) ?? fallback)` in the filterable target
 * pages (Invoices, Exceptions, PaymentRequests, Bank, Credits, Orders, PriceLists,
 * Suppliers, Payments). Wiring it into those pages is owned by their sections.
 */
export function useParamState(name: string, fallback = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const paramValue = params.get(name) ?? fallback;
  const setValue = useCallback((value: string) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    }, { replace: true });
  }, [name, setParams]);
  return [paramValue, setValue];
}
