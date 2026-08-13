// Upload Center queue + surface; see docs/OFFLINE-SYNC-DESIGN.md:
// the state machine incl. the money rule (stored-not-registered shows the registered
// document and never invites a re-upload), the first progressbar in the repo with its
// spaced aria-live announcements, and `runUploadBatch` signature compatibility.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from '../test/msw/server';
import { rest } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';

/** Real supabase-js against the MSW base URL — the wire behaviour stays real. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

import {
  UploadCenter,
  enqueueUploadCenterBatch,
  cancelUploadCenterEntry,
  getUploadCenterSnapshot,
  resetUploadCenterForTests,
  type UploadCenterTaskContext,
} from './UploadCenter';
import { runUploadBatch } from '../lib/uploadBatch';
import { TusUploadCancelledError } from '../lib/tusUpload';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const file = (name: string, size = 4) =>
  new File(['x'.repeat(size)], name, { type: 'application/pdf' });

const renderCenter = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter><UploadCenter /></MemoryRouter>
  </QueryClientProvider>,
);

const entries = () => getUploadCenterSnapshot().entries;

beforeEach(() => {
  resetUploadCenterForTests();
});

describe('runUploadBatch — signature compatibility through the Center queue', () => {
  it('keeps the exact result contract: one sequential attempt per item, failures collected', async () => {
    const order: string[] = [];
    const good = file('good.pdf');
    const bad = file('bad.pdf');
    const boom = new Error('boom');
    const result = await runUploadBatch([good, bad], async (item) => {
      order.push(item.name);
      if (item === bad) throw boom;
      return 'ok';
    });
    expect(order).toEqual(['good.pdf', 'bad.pdf']);
    expect(result.succeeded).toEqual([good]);
    expect(result.failed).toEqual([{ item: bad, error: boom }]);
    // The queue reflects the same outcome per file.
    expect(entries().map((entry) => entry.status)).toEqual(['registered', 'failed']);
  });

  it('runs items strictly sequentially — the next item starts only after the previous settled', async () => {
    const first = deferred();
    const started: string[] = [];
    const batch = runUploadBatch([file('a.pdf'), file('b.pdf')], async (item) => {
      started.push(item.name);
      if (item.name === 'a.pdf') await first.promise;
    });
    await waitFor(() => expect(started).toEqual(['a.pdf']));
    expect(started).toEqual(['a.pdf']);
    first.resolve();
    await batch;
    expect(started).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('state machine and progressbar aria', () => {
  it('walks queued → uploading → registered, with aria-valuenow following and spaced announcements', async () => {
    server.use(rest('document_processing_jobs', []));
    renderCenter();
    const gate = deferred();
    let taskContext: UploadCenterTaskContext | null = null;
    let batch!: Promise<unknown>;
    await act(async () => {
      batch = enqueueUploadCenterBatch([file('doc.pdf')], async (_item, ctx) => {
        taskContext = ctx;
        await gate.promise;
        ctx.markRegistered('doc-5');
      }, { source: 'חשבונית' });
      await Promise.resolve();
    });
    await waitFor(() => expect(taskContext).not.toBeNull());
    expect(entries()[0].status).toBe('uploading');
    expect(screen.getByText('מעלה')).toBeInTheDocument();
    expect(screen.getByText('חשבונית')).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: /doc\.pdf/ });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');

    const live = document.querySelector('[aria-live="polite"]')!;
    await act(async () => taskContext!.onProgress(10));
    expect(bar).toHaveAttribute('aria-valuenow', '10');
    // 10% is below the first milestone — nothing is announced.
    expect(live.textContent).toBe('');

    await act(async () => taskContext!.onProgress(26));
    expect(bar).toHaveAttribute('aria-valuenow', '26');
    expect(live.textContent).toContain('הועלו 25%');

    // Spaced, not per-percent: 40% changes the bar but NOT the announcement.
    await act(async () => taskContext!.onProgress(40));
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(live.textContent).toContain('הועלו 25%');
    expect(live.textContent).not.toContain('40');

    await act(async () => taskContext!.onProgress(80));
    expect(live.textContent).toContain('הועלו 75%');

    await act(async () => {
      gate.resolve();
      await batch;
    });
    expect(entries()[0]).toMatchObject({ status: 'registered', documentId: 'doc-5', percent: 100 });
    await waitFor(() => expect(screen.getByText('נרשם')).toBeInTheDocument());
    expect(live.textContent).toContain('ההעלאה הושלמה');
  });

  it('cancels a queued item without ever running it', async () => {
    const gate = deferred();
    const started: string[] = [];
    let batch!: Promise<{ succeeded: File[]; failed: { item: File; error: unknown }[] }>;
    const second = file('second.pdf');
    await act(async () => {
      batch = enqueueUploadCenterBatch([file('first.pdf'), second], async (item) => {
        started.push(item.name);
        if (item.name === 'first.pdf') await gate.promise;
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(started).toEqual(['first.pdf']));
    const queuedEntry = entries().find((entry) => entry.fileName === 'second.pdf')!;
    expect(queuedEntry.status).toBe('queued');
    expect(queuedEntry.canCancel).toBe(true);
    cancelUploadCenterEntry(queuedEntry.id);
    gate.resolve();
    const result = await batch;
    expect(started).toEqual(['first.pdf']); // the canceled item never ran
    expect(result.succeeded.map((item) => item.name)).toEqual(['first.pdf']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].item).toBe(second);
    expect(result.failed[0].error).toBeInstanceOf(TusUploadCancelledError);
    expect(entries().find((entry) => entry.fileName === 'second.pdf')!.status).toBe('canceled');
  });
});

describe('the money rule — stored-not-registered never invites a re-upload', () => {
  it('shows the stored state, offers ONLY a complete-registration retry, and the retry redoes only the failed step', async () => {
    server.use(rest('document_processing_jobs', []));
    renderCenter();
    const uploadStep = vi.fn();
    const registerStep = vi.fn();
    const stored = new Map<string, string>(); // fileName → stored path (the runner's resume state)
    const item = file('pricelist.pdf');
    let batch!: Promise<unknown>;
    await act(async () => {
      batch = enqueueUploadCenterBatch([item], async (current, ctx) => {
        if (!stored.has(current.name)) {
          uploadStep();
          stored.set(current.name, 'org-1/supplier/sup-1/doc-7/pricelist.pdf');
        }
        ctx.markStored('doc-7');
        registerStep();
        if (registerStep.mock.calls.length === 1) throw new Error('register_supplier_price_document failed');
        ctx.markRegistered('doc-7');
      }, {
        retry: true,
        source: 'מחירון ספק',
        supplierName: 'ספק בדיקה',
        classifyFailure: () => ({
          message: 'רישום המסמך לא הושלם.',
          retryable: true,
          storedSafely: true,
          documentId: 'doc-7',
        }),
      });
      await batch.catch(() => {});
    });

    const entry = entries()[0];
    expect(entry).toMatchObject({ status: 'stored', storedSafely: true, documentId: 'doc-7', canRetry: true });

    const section = screen.getByRole('region', { name: 'מרכז ההעלאות' });
    expect(within(section).getByText('הועלה אך לא נרשם')).toBeInTheDocument();
    expect(within(section).getByText(/קובץ המקור נשמר בבטחה/)).toBeInTheDocument();
    expect(within(section).getByText('ספק בדיקה', { exact: false })).toBeInTheDocument();
    // The ONLY action offered is completing the registration — no re-upload invitation,
    // and the settled-rows cleaner is not offered for the money state either.
    const buttons = within(section).getAllByRole('button');
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['השלמת רישום']);

    await userEvent.click(within(section).getByRole('button', { name: 'השלמת רישום' }));
    await waitFor(() => expect(entries()[0].status).toBe('registered'));
    // The retry redid ONLY the failed step: one upload, two registration attempts.
    expect(uploadStep).toHaveBeenCalledTimes(1);
    expect(registerStep).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(within(section).getByText('נרשם')).toBeInTheDocument());
  });

  it('keeps a terminal registration failure visibly stored but disables blind retry', async () => {
    renderCenter();
    await act(async () => {
      await enqueueUploadCenterBatch([file('terminal.pdf')], async () => {
        throw Object.assign(new Error('הקובץ נשמר, אך נדרשת בדיקה.'), {
          retryable: false,
          resume: {
            storagePath: 'org-1/inbox/terminal-key_terminal.pdf',
            documentId: null,
            clientUploadKey: 'terminal-key',
          },
        });
      }, { retry: true }).catch(() => {});
    });

    const entry = entries()[0];
    expect(entry).toMatchObject({ status: 'stored', storedSafely: true, canRetry: false });
    const section = screen.getByRole('region', { name: 'מרכז ההעלאות' });
    expect(within(section).getByText('הועלה אך לא נרשם')).toBeInTheDocument();
    expect(within(section).getByText('הקובץ נשמר, אך נדרשת בדיקה.')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /ניסיון חוזר|השלמת רישום|שליחה מחדש לעיבוד/ })).toBeNull();
  });

  it('labels a retryable post-registration failure as processing-only and never uploads again', async () => {
    server.use(rest('document_processing_jobs', []));
    renderCenter();
    const uploadStep = vi.fn();
    const registrationStep = vi.fn();
    const enqueueStep = vi.fn();
    let registered = false;
    await act(async () => {
      await enqueueUploadCenterBatch([file('enqueue.pdf')], async (_item, ctx) => {
        if (!registered) {
          uploadStep();
          registrationStep();
          registered = true;
        }
        ctx.markRegistered('doc-enqueue');
        enqueueStep();
        if (enqueueStep.mock.calls.length === 1) throw new TypeError('Failed to fetch');
      }, {
        retry: true,
        classifyFailure: () => ({
          message: 'הקובץ נשמר ונרשם, אך תשובת התור לא התקבלה.',
          retryable: true,
          registered: true,
          documentId: 'doc-enqueue',
        }),
      }).catch(() => {});
    });

    const section = screen.getByRole('region', { name: 'מרכז ההעלאות' });
    const retry = within(section).getByRole('button', { name: 'שליחה מחדש לעיבוד' });
    expect(within(section).getByText('נרשם — העיבוד לא החל')).toBeInTheDocument();
    await userEvent.click(retry);
    await waitFor(() => expect(enqueueStep).toHaveBeenCalledTimes(2));
    expect(uploadStep).toHaveBeenCalledTimes(1);
    expect(registrationStep).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(section).queryByRole('button', {
      name: 'שליחה מחדש לעיבוד',
    })).toBeNull());
  });

  it('shows the registered document (link included) when only the processing enqueue failed', async () => {
    renderCenter();
    await act(async () => {
      await enqueueUploadCenterBatch([file('invoice.pdf')], async (_item, ctx) => {
        ctx.markStored();
        ctx.markRegistered('doc-3');
        throw new Error('enqueue_document_processing failed');
      }, {
        retry: true,
        source: 'חשבונית',
        classifyFailure: () => ({
          message: 'הקובץ נשמר, אך לא נכנס לתור העיבוד.',
          retryable: false,
          registered: true,
          documentId: 'doc-3',
        }),
      }).catch(() => {});
    });

    const entry = entries()[0];
    expect(entry).toMatchObject({ status: 'registered', documentId: 'doc-3', storedSafely: true, canRetry: false });

    const section = screen.getByRole('region', { name: 'מרכז ההעלאות' });
    expect(within(section).getByText('נרשם — העיבוד לא החל')).toBeInTheDocument();
    const link = within(section).getByRole('link', { name: 'מעבר למסמך הרשום' });
    expect(link).toHaveAttribute('href', '/documents/doc-3/review');
    // No retry button (a blind retry could re-upload) — the registered document is the answer.
    expect(within(section).queryByRole('button', { name: /ניסיון חוזר|השלמת רישום|שליחה מחדש לעיבוד/ })).toBeNull();
  });

  it('marks a mixed finished batch as partially completed', async () => {
    server.use(rest('document_processing_jobs', []));
    renderCenter();
    await act(async () => {
      await enqueueUploadCenterBatch([file('ok.pdf'), file('fails.pdf')], async (item, ctx) => {
        if (item.name === 'fails.pdf') throw new Error('upload failed');
        ctx.markRegistered('doc-8');
      }, {
        classifyFailure: () => ({ message: 'ההעלאה נכשלה.', retryable: false }),
      }).catch(() => {});
    });
    await waitFor(() => {
      expect(screen.getByText(/הושלמה חלקית/)).toBeInTheDocument();
    });
    expect(entries().map((entry) => entry.status)).toEqual(['registered', 'failed']);
  });
});
