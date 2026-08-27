import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OwnerProductTour,
  type OwnerProductTourHandle,
} from './ProductTour';
import {
  OWNER_FIRST_RUN_TOUR_ID,
  productTourProgressKey,
  saveProductTourProgress,
} from '../../lib/productTourRegistry';

const owner = { id: 'owner-1', org_id: 'org-1', role: 'owner' as const };

function target(anchor: string, label = anchor) {
  return <button data-tour-anchor={anchor}>{label}</button>;
}

function renderTour({
  profile = owner,
  initial = '/dashboard',
  children = <>{target('dashboard-heading', 'מרכז הבקרה')}<div data-tour-first-run="true" /></>,
  ref = createRef<OwnerProductTourHandle>(),
}: {
  profile?: { id: string; org_id: string; role: 'owner' | 'office' | 'accountant' } | null;
  initial?: string;
  children?: React.ReactNode;
  ref?: React.RefObject<OwnerProductTourHandle | null>;
} = {}) {
  const prepare = vi.fn();
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="*" element={<>
          {children}
          <OwnerProductTour ref={ref} profile={profile} onPrepareStep={prepare} />
        </>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ref, prepare };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 80, y: 80, top: 80, left: 80, right: 280, bottom: 130, width: 200, height: 50,
    toJSON: () => ({}),
  });
});

describe('OwnerProductTour', () => {
  it('matches the highlighted element corner radii instead of drawing a fixed rounded box', async () => {
    renderTour({
      children: <>
        <button data-tour-anchor="dashboard-heading" style={{ borderRadius: '9999px' }}>מרכז הבקרה</button>
        <div data-tour-first-run="true" />
      </>,
    });
    const spotlight = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.product-tour-spotlight');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(spotlight.style.getPropertyValue('--product-tour-radius-start-start')).toBe('10007px');
    expect(spotlight.style.getPropertyValue('--product-tour-radius-start-end')).toBe('10007px');
    expect(spotlight.style.getPropertyValue('--product-tour-radius-end-end')).toBe('10007px');
    expect(spotlight.style.getPropertyValue('--product-tour-radius-end-start')).toBe('10007px');
  });

  it('auto-starts only for an owner on a real first-run dashboard', async () => {
    renderTour();
    expect(await screen.findByRole('dialog', { name: /מרכז הבקרה/ })).toBeInTheDocument();

    cleanup();
    localStorage.clear();
    renderTour({ profile: { ...owner, role: 'office' } });
    expect(screen.queryByText('1 מתוך 16')).not.toBeInTheDocument();
  });

  it('persists dismissal and supports an explicit restart', async () => {
    const ref = createRef<OwnerProductTourHandle>();
    renderTour({ ref });
    await screen.findByText('1 מתוך 16');
    fireEvent.click(screen.getByRole('button', { name: 'דלג על המדריך' }));
    expect(screen.queryByText('1 מתוך 16')).not.toBeInTheDocument();
    expect(localStorage.getItem(productTourProgressKey('org-1', 'owner-1'))).toContain('dismissed');

    act(() => ref.current?.start());
    expect(await screen.findByText('1 מתוך 16')).toBeInTheDocument();
  });

  it('advances a click step only through the highlighted safe target', async () => {
    saveProductTourProgress('org-1', 'owner-1', {
      tourId: OWNER_FIRST_RUN_TOUR_ID,
      status: 'active',
      stepId: 'open-suppliers',
      updatedAt: new Date().toISOString(),
    });
    renderTour({ children: target('nav-suppliers', 'ספקים') });
    await screen.findByText('5 מתוך 16');
    fireEvent.click(screen.getByRole('button', { name: 'ספקים' }));
    await waitFor(() => expect(localStorage.getItem(productTourProgressKey('org-1', 'owner-1'))).toContain('supplier-screen'));
  });

  it('offers retry and skip instead of trapping the user when an anchor is missing', async () => {
    vi.useFakeTimers();
    const ref = createRef<OwnerProductTourHandle>();
    renderTour({ children: null, ref });
    act(() => ref.current?.start());
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(screen.getByText('האלמנט לא זמין במסך הזה')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'נסה שוב' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'דלג על השלב' })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('restores active progress when the authenticated profile arrives after mount', async () => {
    saveProductTourProgress('org-1', 'owner-1', {
      tourId: OWNER_FIRST_RUN_TOUR_ID,
      status: 'active',
      stepId: 'open-suppliers',
      updatedAt: new Date().toISOString(),
    });
    const prepare = vi.fn();
    const view = render(
      <MemoryRouter initialEntries={['/dashboard']}>
        {target('nav-suppliers', 'ספקים')}
        <OwnerProductTour profile={null} onPrepareStep={prepare} />
      </MemoryRouter>,
    );
    view.rerender(
      <MemoryRouter initialEntries={['/dashboard']}>
        {target('nav-suppliers', 'ספקים')}
        <OwnerProductTour profile={owner} onPrepareStep={prepare} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('5 מתוך 16')).toBeInTheDocument();
  });

  it('keeps keyboard focus within the highlighted target and tour controls', async () => {
    saveProductTourProgress('org-1', 'owner-1', {
      tourId: OWNER_FIRST_RUN_TOUR_ID,
      status: 'active',
      stepId: 'open-suppliers',
      updatedAt: new Date().toISOString(),
    });
    renderTour({ children: <>{target('nav-suppliers', 'ספקים')}<button>מחוץ לסיור</button></> });
    const highlighted = await screen.findByRole('button', { name: 'ספקים' });
    await waitFor(() => expect(document.activeElement).toBe(highlighted));
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'סגירת המדריך' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(localStorage.getItem(productTourProgressKey('org-1', 'owner-1'))).toContain('dismissed');
  });
});
