// Upload Center queue + surface; see docs/OFFLINE-SYNC-DESIGN.md:
// the state machine incl. the money rule (stored-not-registered shows the registered
// document and never invites a re-upload), the first progressbar in the repo with its
// spaced aria-live announcements, and `runUploadBatch` signature compatibility.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { he } from '../lib/i18n/dictionaries/he';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { DOCUMENT_PROCESSING_CHANGED_EVENT } from '../lib/useDocumentProcessing';

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
  enqueueUploadCenterBatch as enqueueUploadCenterBatchRaw,
  cancelUploadCenterEntry,
  getUploadCenterSnapshot,
  resetUploadCenterForTests,
  type UploadCenterBatchOptions,
  type UploadCenterTaskContext,
} from './UploadCenter';
import { runUploadBatch, type UploadBatchI18n } from '../lib/uploadBatch';
import { TusUploadCancelledError } from '../lib/tusUpload';
import { LocaleProvider, translateIn } from '../lib/i18n/LocaleProvider';
import { toErrorKey, toHebrewError } from '../lib/errors';

const TEST_I18N: UploadBatchI18n = {
  t: (key, vars) => translateIn('he', key, vars),
  errorText: toHebrewError,
};
const ENGLISH_I18N: UploadBatchI18n = {
  t: (key, vars) => translateIn('en', key, vars),
  errorText: (error) => translateIn('en', `errors.${toErrorKey(error)}` as never),
};

const enqueueUploadCenterBatch = <T,>(
  items: readonly T[],
  run: (item: T, context: UploadCenterTaskContext) => Promise<unknown>,
  options: Omit<UploadCenterBatchOptions<T>, keyof UploadBatchI18n> = {},
) => enqueueUploadCenterBatchRaw(items, run, { ...options, ...TEST_I18N });

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

const renderCenter = (locale: 'he' | 'en' = 'he') => render(
  <LocaleProvider initialLocale={locale}>
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter><UploadCenter /></MemoryRouter>
    </QueryClientProvider>
  </LocaleProvider>,
);

const entries = () => getUploadCenterSnapshot().entries;

/** The read the surface actually performs: `useDocumentProcessing` calls this RPC, and only falls
 *  back to the `document_processing_jobs` table on a database that predates it. */
const jobsRpc = (rows: unknown[]) =>
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_document_processing_statuses`, () => HttpResponse.json(rows));

const queuedJob = (documentId: string) => ({
  id: `job-${documentId}`, org_id: 'org-1', document_id: documentId, requested_by: 'owner-1',
  status: 'queued', input_checksum: 'etag:1', contract_version: '1', priority: 0,
  attempt_count: 0, lease_owner: null, lease_until: null,
  processing_attempt_id: null, processing_attempt_started_at: null,
  last_error_code: null, last_error_message: null,
  created_at: new Date(Date.now() - 5_000).toISOString(),
  updated_at: new Date(Date.now() - 5_000).toISOString(),
  queue_age_seconds: 5, is_stuck: false, stuck_reason: null,
});

const uploadCenter = () => screen.getByRole('region', { name: 'מרכז ההעלאות' });

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
    }, TEST_I18N);
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
    }, TEST_I18N);
    await waitFor(() => expect(started).toEqual(['a.pdf']));
    expect(started).toEqual(['a.pdf']);
    first.resolve();
    await batch;
    expect(started).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('state machine and progressbar aria', () => {
  it('shows the file name and state without non-actionable byte telemetry', async () => {
    server.use(jobsRpc([]));
    renderCenter();
    await act(async () => {
      await enqueueUploadCenterBatch([file('measured.pdf', 2048)], async (_item, context) => {
        context.markRegistered('doc-measured');
      });
    });

    const section = uploadCenter();
    expect(within(section).getByText('measured.pdf')).toBeInTheDocument();
    expect(within(section).queryByText('2 KB')).toBeNull();
  });

  it('renders the queue, announcements and default failure in English without Hebrew leakage', async () => {
    server.use(jobsRpc([]));
    renderCenter('en');
    await act(async () => {
      await enqueueUploadCenterBatchRaw(
        [file('ok.pdf'), file('bad.pdf')],
        async (item, context) => {
          if (item.name === 'bad.pdf') throw new Error('tus_upload_forbidden');
          context.markRegistered('doc-ok');
        },
        ENGLISH_I18N,
      );
    });

    const section = screen.getByRole('region', { name: 'Upload center' });
    expect(within(section).getByText(/Partially completed batch/)).toBeInTheDocument();
    expect(within(section).getByText(/file could not be uploaded/i)).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/[֐-׿]/);
  });

  it('walks queued → uploading → registered, with aria-valuenow following and spaced announcements', async () => {
    server.use(jobsRpc([]));
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
    expect(screen.getByText('מעלה את הקובץ')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('המסמך נרשם במערכת')).toBeInTheDocument());
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
    server.use(jobsRpc([]));
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
    expect(within(section).getByText('הקובץ נשמר, אך עדיין אין מסמך במערכת')).toBeInTheDocument();
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
    await waitFor(() => expect(within(section).getByText('המסמך נרשם במערכת')).toBeInTheDocument());
  });

  it('keeps a terminal registration failure visibly stored but disables blind retry', async () => {
    renderCenter();
    await act(async () => {
      await enqueueUploadCenterBatch([file('terminal.pdf')], async () => {
        // A registered CODE, which is what the upload surface actually throws now. The fixture
        // used to carry a finished Hebrew sentence and the Center echoed it, so this case
        // passed while `tus_upload_forbidden` would have reached a reader unchanged.
        throw Object.assign(new Error('document_registration_failed'), {
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
    expect(within(section).getByText('הקובץ נשמר, אך עדיין אין מסמך במערכת')).toBeInTheDocument();
    expect(within(section).getByText(he.errors.document_registration_failed)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /ניסיון חוזר|השלמת רישום|שליחה מחדש לעיבוד/ })).toBeNull();
  });

  it('labels a retryable post-registration failure as processing-only and never uploads again', async () => {
    server.use(jobsRpc([]));
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
    const retry = within(section).getByRole('button', { name: 'שליחה לעיבוד' });
    expect(within(section).getByText('המסמך נרשם; אין להעלות שוב. הקריאה עוד לא התחילה.')).toBeInTheDocument();
    await userEvent.click(retry);
    await waitFor(() => expect(enqueueStep).toHaveBeenCalledTimes(2));
    expect(uploadStep).toHaveBeenCalledTimes(1);
    expect(registrationStep).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(section).queryByRole('button', {
      name: 'שליחה לעיבוד',
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
    expect(within(section).getByText('המסמך נרשם; אין להעלות שוב. הקריאה עוד לא התחילה.')).toBeInTheDocument();
    const link = within(section).getByRole('link', { name: 'מעבר למסמך הרשום' });
    expect(link).toHaveAttribute('href', '/documents/doc-3/review');
    // No retry button (a blind retry could re-upload) — the registered document is the answer.
    expect(within(section).queryByRole('button', { name: /ניסיון חוזר|השלמת רישום|שליחה מחדש לעיבוד/ })).toBeNull();
  });

  /**
   * The row that says "do not upload this again" is the one row on this surface that could never
   * learn it was wrong. `stored` means the object is durable and the registry row's fate is
   * UNKNOWN — the response that would have said so was lost — and the poll beside it only ever
   * asked about rows already marked `registered`. So the instruction stood for the rest of the
   * session no matter what the server actually held.
   *
   * The protection is not weakened here, it is given a way to end: a processing job carries a
   * foreign key to `documents`, so a job for this id is proof the registry row exists. That is the
   * only evidence accepted. Silence from the server changes nothing.
   */
  it('holds the stored row until a job proves the registration landed, then shows the real state', async () => {
    server.use(jobsRpc([]));
    renderCenter();
    await act(async () => {
      await enqueueUploadCenterBatch([file('lost-response.pdf')], async (_item, ctx) => {
        ctx.markStored('doc-9');
        throw new Error('register_document response lost');
      }, {
        retry: true,
        classifyFailure: () => ({
          message: 'תשובת הרישום לא התקבלה.',
          retryable: true,
          storedSafely: true,
          documentId: 'doc-9',
        }),
      }).catch(() => {});
    });

    // The server knows of no job for this document, so nothing is withdrawn.
    expect(within(uploadCenter()).getByText('הקובץ נשמר, אך עדיין אין מסמך במערכת')).toBeInTheDocument();
    expect(within(uploadCenter()).getByText(/אין להעלות אותו שוב/)).toBeInTheDocument();
    expect(entries()[0].status).toBe('stored');

    // Now it does. The lost response is settled by the server, not by a timeout or a guess.
    server.use(jobsRpc([queuedJob('doc-9')]));
    await act(async () => {
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.resolve();
    });

    await waitFor(() => expect(within(uploadCenter()).getByText('ממתין לעיבוד')).toBeInTheDocument());
    expect(entries()[0].status).toBe('registered');
    expect(within(uploadCenter()).queryByText('הקובץ נשמר, אך עדיין אין מסמך במערכת')).toBeNull();
    expect(within(uploadCenter()).queryByText(/אין להעלות אותו שוב/)).toBeNull();
  });

  /**
   * "נרשם — העיבוד לא החל" is a claim about the server. A row with no document id is never polled,
   * so nothing can ever supersede it: the transport error caught once at upload time was rendered
   * as a live state for the rest of the session. With an id the claim stays — the case one test
   * above ('shows the registered document (link included)…') is exactly that, and it still passes.
   */
  it('does not report a server state for a row it has no way to ask about', async () => {
    renderCenter();
    await act(async () => {
      await enqueueUploadCenterBatch([file('no-id.pdf')], async (_item, ctx) => {
        ctx.markRegistered();
        throw new Error('enqueue_document_processing failed');
      }, {
        classifyFailure: () => ({
          message: 'הקובץ נשמר ונרשם, אך תשובת התור לא התקבלה.',
          retryable: false,
          registered: true,
        }),
      }).catch(() => {});
    });

    const section = uploadCenter();
    expect(entries()[0]).toMatchObject({ status: 'registered', documentId: null });
    expect(within(section).queryByText('המסמך נרשם; אין להעלות שוב. הקריאה עוד לא התחילה.')).toBeNull();
    // What is certainly true, plus the report of what went wrong — as a report, not as a status.
    expect(within(section).getByText('המסמך נרשם במערכת')).toBeInTheDocument();
    expect(within(section).getByText(/תשובת התור לא התקבלה/)).toBeInTheDocument();
  });

  it('marks a mixed finished batch as partially completed', async () => {
    server.use(jobsRpc([]));
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

/**
 * The live region is the only surface here with no way of noticing on its own that a state ended.
 * The visible offline note is re-evaluated against `navigator.onLine` on every render; this text
 * just sits in the DOM until something overwrites it — so "אין חיבור לרשת. ההעלאות ממתינות" was
 * still what a screen reader read back long after the network returned and the queue drained.
 */
describe('the announcement channel says what is true now', () => {
  /** Offline, with the runner held open so the channel can be read while the transfer is running
   *  rather than after an outcome announcement has already replaced everything. */
  async function queueWhileOffline() {
    const gate = deferred();
    renderCenter();
    let batch!: Promise<unknown>;
    await act(async () => {
      // No document id: nothing to poll, so this stays about the announcement alone.
      batch = enqueueUploadCenterBatch([file('offline.pdf')], async (_item, ctx) => {
        await gate.promise;
        ctx.markRegistered();
      });
      await Promise.resolve();
    });
    const live = document.querySelector('[aria-live="polite"]')!;
    await waitFor(() => expect(live.textContent).toContain('אין חיבור לרשת'));
    return { batch, gate, live };
  }

  it('replaces the waiting-for-network sentence the moment the queue resumes', async () => {
    const network = { online: false };
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => network.online });
    try {
      const { batch, gate, live } = await queueWhileOffline();

      network.online = true;
      await act(async () => { window.dispatchEvent(new Event('online')); });

      // Read WHILE the upload runs. Left alone the region still said the queue was waiting for a
      // network that had been back for however long the transfer took.
      await waitFor(() => expect(live.textContent).toContain('החיבור חזר'));
      expect(live.textContent).not.toContain('אין חיבור לרשת');

      await act(async () => { gate.resolve(); await batch; });
    } finally {
      Reflect.deleteProperty(navigator, 'onLine');
    }
  });

  it('empties the channel when the waiting file is canceled instead of resumed', async () => {
    const network = { online: false };
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => network.online });
    try {
      const { batch, live } = await queueWhileOffline();

      // The one path that never reaches an outcome announcement: canceled while waiting. The queue
      // then drains with nothing left in it, and the last thing said was that it was still waiting.
      cancelUploadCenterEntry(entries()[0].id);
      network.online = true;
      await act(async () => {
        window.dispatchEvent(new Event('online'));
        await batch;
      });

      expect(entries()[0].status).toBe('canceled');
      expect(live.textContent).toBe('');
    } finally {
      Reflect.deleteProperty(navigator, 'onLine');
    }
  });
});
