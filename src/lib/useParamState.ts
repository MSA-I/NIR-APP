import { useEffect, useState } from 'react';
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
 * This keeps local edits working (the user changing a dropdown calls the setter) while
 * adopting a new value whenever the URL param itself changes. It reads the URL but does not
 * write back to it: the setter updates local state only, matching how the existing filters
 * behave once the user takes over.
 *
 * Intended to replace `useState(params.get(name) ?? fallback)` in the filterable target
 * pages (Invoices, Exceptions, PaymentRequests, Bank, Credits, Orders, PriceLists,
 * Suppliers, Payments). Wiring it into those pages is owned by their sections.
 */
export function useParamState(name: string, fallback = ''): [string, (v: string) => void] {
  const [params] = useSearchParams();
  const paramValue = params.get(name) ?? fallback;
  const [value, setValue] = useState(paramValue);
  useEffect(() => { setValue(paramValue); }, [paramValue]);
  return [value, setValue];
}
