import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentScanState } from '../../lib/useDocumentScanning';

const mocks = vi.hoisted(() => ({ createSignedUrl: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: () => ({ createSignedUrl: mocks.createSignedUrl }) },
  },
}));

import { DocumentScanPreview, scanFailureAction } from './DocumentScanPreview';
import { DOCUMENT_UPLOAD_ACCEPT } from '../FileUpload';

const base: DocumentScanState = {
  document_id: 'document-1',
  scan_job_id: 'scan-1',
  processing_job_id: 'processing-1',
  status: 'failed',
  requested_mode: 'auto',
  manual_corners: null,
  last_error_code: 'processing_timeout',
  last_error_message: null,
  output_id: null,
  output_storage_path: null,
  output_mode: null,
  detected_corners: null,
  corners_source: null,
  rotation_degrees: null,
  accepted: false,
  updated_at: '2026-09-05T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.test/source' }, error: null });
});

describe('failed scan recovery', () => {
  it.each([
    ['corrupt_document', 'replace'],
    ['decompressed_size_limit', 'replace'],
    ['file_size_limit', 'replace'],
    ['processing_resource_failure', 'retry'],
    ['processing_timeout', 'retry'],
    ['scan_image_too_small', 'replace'],
    ['claim_attempt_limit_exceeded', 'retry'],
    ['document_deleted', 'none'],
    ['unknown_code', 'none'],
  ] as const)('maps %s to exactly one safe action', (code, action) => {
    expect(scanFailureAction(code).action).toBe(action);
  });

  it('offers one retry for timeout and never renders the corner editor', async () => {
    const onRetry = vi.fn();
    render(<DocumentScanPreview
      state={base}
      originalStoragePath="org/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn()}
      onRetry={onRetry}
      onReplace={vi.fn()}
    />);
    expect(await screen.findByRole('button', { name: 'ניסיון נוסף' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /פינה .* אחוזים/ })).toBeNull();
    expect(screen.queryByText('קרא כמו שהוא')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'ניסיון נוסף' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('replaces a corrupt source with one newly selected file', async () => {
    const onReplace = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<DocumentScanPreview
      state={{ ...base, last_error_code: 'corrupt_document' }}
      originalStoragePath="org/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn()}
      onRetry={vi.fn()}
      onReplace={onReplace}
    />);
    await screen.findByText(/קובץ התמונה פגום/);
    const input = container.querySelector('input[type="file"]')!;
    expect(input).toHaveAttribute('accept', DOCUMENT_UPLOAD_ACCEPT);
    const file = new File(['replacement'], 'replacement.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith(file));
    expect(screen.queryByRole('button', { name: /פינה/ })).toBeNull();
  });

  it('states explicit no-action for deleted and unknown failures', async () => {
    const { rerender } = render(<DocumentScanPreview
      state={{ ...base, last_error_code: 'document_deleted' }}
      originalStoragePath="org/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn()}
      onRetry={vi.fn()}
      onReplace={vi.fn()}
    />);
    expect(await screen.findByText(/אין פעולת שחזור בטוחה/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<DocumentScanPreview
      state={{ ...base, last_error_code: 'unknown_code' }}
      originalStoragePath="org/source.jpg"
      fileName="invoice.jpg"
      readOnly={false}
      onChanged={vi.fn()}
      onRetry={vi.fn()}
      onReplace={vi.fn()}
    />);
    expect(screen.getByText(/אין פעולת שחזור בטוחה/)).toBeInTheDocument();
  });
});
