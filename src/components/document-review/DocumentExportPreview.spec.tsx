import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocaleProvider } from '../../lib/i18n/LocaleProvider';
import type { DocumentExportResult } from '../../lib/documentExport';
import type { ReviewSnapshot } from './model';

const generateDocumentExport = vi.hoisted(() => vi.fn());
const selected = vi.hoisted(() => ({
  version: { id: 'version-1', version: 3 },
  contract: {
    name: 'תבנית ספק מקורית',
    format: 'table' as const,
    columns: [{ key: 'item', label: 'שם מהמפרט', type: 'text' as const }],
  },
}));

vi.mock('../../lib/documentExport', () => ({ generateDocumentExport }));
vi.mock('./model', () => ({ resolveExportTemplateWinner: () => selected }));

import { DocumentExportPreview } from './DocumentExportPreview';

const snapshot = {
  interpretation: { payload: { document_type: 'invoice' } },
} as unknown as ReviewSnapshot;

const result: DocumentExportResult = {
  format: 'table',
  mimeType: null,
  fileExtension: null,
  checksum: `sha256:${'a'.repeat(64)}`,
  content: {
    columns: selected.contract.columns,
    rows: [{ item: 'עגבניות מהמסמך' }],
  },
  columns: selected.contract.columns,
  rows: [{ item: 'עגבניות מהמסמך' }],
};

function renderPreview() {
  render(
    <LocaleProvider initialLocale="en">
      <DocumentExportPreview snapshot={snapshot} actorId="owner-1" autoFocus={false} />
    </LocaleProvider>,
  );
}

describe('DocumentExportPreview language boundary', () => {
  beforeEach(() => {
    generateDocumentExport.mockReset();
  });

  it('renders interface in English and preserves template and document values', async () => {
    generateDocumentExport.mockResolvedValue(result);
    renderPreview();
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: 'Export preview' })).toBeInTheDocument();
    expect(screen.getByText(/תבנית ספק מקורית/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Generate preview' }));

    expect(await screen.findByText('Preview result')).toBeInTheDocument();
    expect(screen.getByText('שם מהמפרט')).toBeInTheDocument();
    expect(screen.getByText('עגבניות מהמסמך')).toBeInTheDocument();
    expect(screen.getByText('Table · 1 row')).toBeInTheDocument();
  });

  it('resolves preview failure in the reader language', async () => {
    generateDocumentExport.mockRejectedValue(new Error('missing_required_field'));
    renderPreview();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Generate preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A preview could not be generated from the current template and interpretation.',
    );
  });
});
