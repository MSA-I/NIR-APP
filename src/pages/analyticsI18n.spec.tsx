import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

vi.mock('../lib/useQuery', () => ({
  useQuery: () => ({
    data: [{ id: 'supplier-1', name: 'ירקות השדה', rating: 4, m: null }],
    loading: false,
    error: null,
  }),
  unwrap: (value: unknown) => value,
}));

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import Analytics from './Analytics';

describe('Analytics language boundary', () => {
  it('renders performance copy in English and preserves the supplier name', () => {
    render(
      <LocaleProvider initialLocale="en"><MemoryRouter><Analytics /></MemoryRouter></LocaleProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Supplier performance' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Price changes (last 90 days)' })).toBeInTheDocument();
    expect(screen.getAllByText('ירקות השדה')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Data table — horizontally scrollable' })).toBeInTheDocument();
    expect(screen.getByText('1 record')).toBeInTheDocument();
    expect(screen.queryByText('ביצועי ספקים')).toBeNull();
  });
});
