import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';
import { fmtLeadDays, PriceSparkline, RatingStars } from './supplier-metrics';

describe('supplier metrics language boundary', () => {
  it('formats lead time in the requested locale', () => {
    expect(fmtLeadDays(2.5, 'he')).toBe('2.5 ימים');
    expect(fmtLeadDays(2.5, 'en')).toBe('2.5 days');
    expect(fmtLeadDays(null, 'en')).toBe('—');
  });

  it('renders rating and trend accessibility copy in English', () => {
    render(
      <LocaleProvider initialLocale="en">
        <RatingStars value={4} />
        <PriceSparkline points={[10, 12]} />
      </LocaleProvider>,
    );
    expect(screen.getByLabelText('Rating 4 out of 5')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Price trend: increased by 20.0% across 2 price changes' }))
      .toBeInTheDocument();
  });
});
