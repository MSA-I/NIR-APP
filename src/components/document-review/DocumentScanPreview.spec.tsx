import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentScanState } from '../../lib/useDocumentScanning';
import { DocumentScanPreview } from './DocumentScanPreview';

const mocks = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: vi.fn(() => ({ createSignedUrl: mocks.createSignedUrl })) },
  },
}));

const base: DocumentScanState = {
  document_id: '11111111-1111-4111-8111-111111111111',
  scan_job_id: '22222222-2222-4222-8222-222222222222',
  processing_job_id: '33333333-3333-4333-8333-333333333333',
  status: 'queued',
  requested_mode: 'auto',
  manual_corners: null,
  last_error_code: null,
  last_error_message: null,
  output_id: null,
  output_storage_path: null,
  output_mode: null,
  detected_corners: null,
  corners_source: null,
  rotation_degrees: null,
  accepted: false,
  updated_at: '2026-08-13T12:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.test/source' }, error: null });
  mocks.rpc.mockResolvedValue({ data: {}, error: null });
});

describe('DocumentScanPreview', () => {
  it('holds OCR while the scanner is working', async () => {
    render(<DocumentScanPreview
      state={base}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn()}
    />);

    expect(screen.getByRole('status')).toHaveTextContent('החילוץ יתחיל רק לאחר אישור');
    expect(screen.queryByRole('button', { name: 'אישור הסריקה' })).not.toBeInTheDocument();
  });

  it('shows original and enhanced previews before explicit acceptance', async () => {
    const changed = vi.fn().mockResolvedValue(true);
    const state: DocumentScanState = {
      ...base,
      status: 'ready',
      output_id: '44444444-4444-4444-8444-444444444444',
      output_storage_path: 'org/document/job/scan.png',
      output_mode: 'black_and_white',
    };
    render(<DocumentScanPreview
      state={state}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={changed}
    />);

    expect(await screen.findByAltText('המסמך המקורי invoice.jpg')).toBeInTheDocument();
    expect(screen.getByAltText('סריקה משופרת של invoice.jpg')).toBeInTheDocument();
    expect(screen.getByText(/בדוק שהדף שלם וקריא/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'אישור הסריקה' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('accept_document_scan', {
      p_scan_output_id: state.output_id,
    }));
    expect(changed).toHaveBeenCalledOnce();
  });

  it('names a full-frame fallback instead of presenting it as detected automatic corners', async () => {
    const state: DocumentScanState = {
      ...base,
      status: 'ready',
      output_id: '44444444-4444-4444-8444-444444444444',
      output_storage_path: 'org/document/job/scan.png',
      output_mode: 'grayscale',
      detected_corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
      corners_source: 'full_frame_fallback',
      rotation_degrees: 0,
    };
    render(<DocumentScanPreview
      state={state}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn()}
    />);

    expect(await screen.findByText(/הדף ממלא את כל מסגרת המקור/)).toBeInTheDocument();
    expect(screen.getByText(/לא זוהה מלבן גבולות אוטומטי/)).toBeInTheDocument();
  });

  it('creates an immutable successor when a ready crop needs corrected boundaries', async () => {
    const changed = vi.fn().mockResolvedValue(true);
    const state: DocumentScanState = {
      ...base,
      status: 'ready',
      output_id: '44444444-4444-4444-8444-444444444444',
      output_storage_path: 'org/document/job/scan.png',
      output_mode: 'black_and_white',
      detected_corners: [[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]],
      corners_source: 'automatic',
      rotation_degrees: 0,
    };
    render(<DocumentScanPreview
      state={state}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={changed}
    />);

    await userEvent.click(await screen.findByRole('button', { name: 'תיקון גבולות' }));
    await userEvent.click(screen.getByRole('button', { name: 'יצירת סריקה מהפינות' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('recover_document_scan', {
      p_scan_job_id: state.scan_job_id,
      p_corners: state.detected_corners,
      p_reason: 'manual boundary correction after scan review',
    }));
    expect(changed).toHaveBeenCalledOnce();
  });

  it('offers four keyboard-adjustable corners after detection failure', async () => {
    const changed = vi.fn().mockResolvedValue(true);
    const state: DocumentScanState = {
      ...base,
      status: 'needs_corners',
      last_error_code: 'document_not_detected',
      last_error_message: 'manual corner selection is required',
    };
    render(<DocumentScanPreview
      state={state}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={changed}
    />);

    const firstCorner = await screen.findByRole('button', { name: /פינה שמאלית עליונה/ });
    expect(screen.getAllByRole('button', { name: /פינה .* אחוזים/ })).toHaveLength(4);
    fireEvent.keyDown(firstCorner, { key: 'ArrowRight' });
    await userEvent.click(screen.getByRole('button', { name: 'יצירת סריקה מהפינות' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('submit_document_scan_corners', {
      p_scan_job_id: state.scan_job_id,
      p_corners: [[0.055, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]],
    }));
    expect(changed).toHaveBeenCalledOnce();
  });

  /**
   * `accepted` is where this card's job ends and never moves again. The note that used to render
   * here said the reading was happening RIGHT NOW — so a document that had been read, interpreted
   * and put in front of a reviewer still carried, at the bottom of the same screen, a sentence
   * announcing that its extraction was in progress. Where the document actually is now belongs to
   * the lifecycle strip in the workspace above, which reads it off the job the server reports.
   */
  it('makes no claim about a reading in progress once the scan has been accepted', async () => {
    render(<DocumentScanPreview
      state={{
        ...base,
        status: 'accepted',
        accepted: true,
        output_id: '44444444-4444-4444-8444-444444444444',
        output_storage_path: 'org/document/job/scan.png',
        output_mode: 'grayscale',
      }}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn()}
    />);

    // What the card still says: this scan was approved, and here is what was approved.
    expect(await screen.findByAltText('סריקה משופרת של invoice.jpg')).toBeInTheDocument();
    expect(screen.getByText('הסריקה אושרה')).toBeInTheDocument();
    // What it no longer says.
    expect(screen.queryByText(/קורא כעת/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps scan approval and corner correction disabled in read-only mode', async () => {
    const ready: DocumentScanState = {
      ...base,
      status: 'ready',
      output_id: '44444444-4444-4444-8444-444444444444',
      output_storage_path: 'org/document/job/scan.png',
      output_mode: 'grayscale',
      detected_corners: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]],
      corners_source: 'automatic',
      rotation_degrees: 0,
    };
    const { rerender } = render(<DocumentScanPreview
      state={ready}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly
      onChanged={vi.fn()}
    />);

    expect(await screen.findByRole('button', { name: 'אישור הסריקה' })).toBeDisabled();
    expect(screen.getByText(/אפשר לצפות בסריקה, אך אי אפשר לאשר/)).toBeInTheDocument();

    rerender(<DocumentScanPreview
      state={{
        ...base,
        status: 'needs_corners',
        last_error_code: 'document_not_detected',
        last_error_message: 'manual corner selection is required',
      }}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly
      onChanged={vi.fn()}
    />);

    expect(await screen.findByRole('button', { name: /פינה שמאלית עליונה/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'יצירת סריקה מהפינות' })).toBeDisabled();
    expect(screen.getByText(/אי אפשר לשמור תיקון פינות/)).toBeInTheDocument();
  });
});

/**
 * The scan card on a phone. Two full-width page images stand between the top of it and the one
 * question it asks, so the answer travels with the reader — but only for the approval. The corner
 * editor deliberately keeps its button inline: its two lower handles are dragged along the image's
 * bottom edge, which is exactly the band a fixed bar would occupy.
 */
describe('בטלפון — אישור הסריקה מגיע לאגודל, עריכת הפינות לא', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  });
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  const readyState: DocumentScanState = {
    ...base,
    status: 'ready',
    output_id: '44444444-4444-4444-8444-444444444444',
    output_storage_path: 'org/document/job/scan.png',
    output_mode: 'black_and_white',
    detected_corners: [[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]],
    corners_source: 'automatic',
    rotation_degrees: 0,
  };

  it('מציג את "אישור הסריקה" פעם אחת, אחרי התמונות, ולבדו באזור ההכרעה', async () => {
    render(<DocumentScanPreview
      state={readyState}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn().mockResolvedValue(true)}
    />);

    const cta = await screen.findByRole('button', { name: 'אישור הסריקה' });
    expect(screen.getAllByRole('button', { name: 'אישור הסריקה' })).toHaveLength(1);
    const decision = screen.getByTestId('primary-decision');
    expect(decision).toContainElement(cta);
    // One control in the decision. The exception path stays beside the images it is about — and on
    // this screen the images stay ABOVE the button, because they are what is being approved.
    expect(decision).not.toContainElement(screen.getByRole('button', { name: 'תיקון גבולות' }));
    const original = screen.getByAltText('המסמך המקורי invoice.jpg');
    expect(original.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('אינו מצמיד את "יצירת סריקה מהפינות" — שם היד עובדת על התמונה עצמה', async () => {
    render(<DocumentScanPreview
      state={{ ...readyState, status: 'needs_corners' }}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn().mockResolvedValue(true)}
    />);

    expect(await screen.findByRole('button', { name: 'יצירת סריקה מהפינות' })).toBeInTheDocument();
    expect(screen.queryByTestId('primary-decision')).toBeNull();
  });

  it('סריקה שכבר אושרה אינה מקבלת פס פעולה ריק', async () => {
    render(<DocumentScanPreview
      state={{ ...readyState, status: 'accepted', accepted: true }}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn().mockResolvedValue(true)}
    />);

    expect(await screen.findByAltText('המסמך המקורי invoice.jpg')).toBeInTheDocument();
    expect(screen.queryByTestId('primary-decision')).toBeNull();
  });
});

describe('ארגון בקריאה בלבד — הכפתור המת נשאר ליד ההסבר שלו', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  });
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  it('משאיר את הכפתור המנוטרל בזרימה, ליד המשפט שמסביר אותו', async () => {
    render(<DocumentScanPreview
      state={{
        ...base,
        status: 'ready',
        output_id: '44444444-4444-4444-8444-444444444444',
        output_storage_path: 'org/document/job/scan.png',
        output_mode: 'black_and_white',
      }}
      originalStoragePath="org/inbox/source.jpg"
      fileName="invoice.jpg"
      readOnly
      onChanged={vi.fn().mockResolvedValue(true)}
    />);

    const cta = await screen.findByRole('button', { name: 'אישור הסריקה' });
    expect(cta).toBeDisabled();
    // Nothing is fixed to the phone's bottom edge on this screen any more, pressable or not: the
    // button and the sentence that explains it are one block, in the flow, together.
    expect(screen.queryByTestId('sticky-primary-action')).toBeNull();
    expect(screen.queryByTestId('sticky-primary-action-clearance')).toBeNull();
    expect(screen.getByTestId('primary-decision')).toContainElement(cta);
    expect(screen.getByText(/אי אפשר לאשר אותה לחילוץ/)).toBeInTheDocument();
  });
});
