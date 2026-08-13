import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(screen.queryByRole('button', { name: 'אישור והמשך לחילוץ' })).not.toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: 'אישור והמשך לחילוץ' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('accept_document_scan', {
      p_scan_output_id: state.output_id,
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

    expect(await screen.findByRole('button', { name: 'אישור והמשך לחילוץ' })).toBeDisabled();
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
