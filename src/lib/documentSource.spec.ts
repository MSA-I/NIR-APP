import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rendersAsActiveContent, signedDocumentSourceUrl } from './documentSource';

const mocks = vi.hoisted(() => ({ createSignedUrl: vi.fn(), from: vi.fn() }));

vi.mock('./supabase', () => ({
  supabase: {
    storage: {
      from: (bucket: string) => {
        mocks.from(bucket);
        return { createSignedUrl: mocks.createSignedUrl };
      },
    },
  },
}));

beforeEach(() => {
  mocks.createSignedUrl.mockReset();
  mocks.from.mockReset();
  mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://files.test/x' }, error: null });
});

describe('the signed link to an original document', () => {
  it('asks Storage for a download whenever the browser would execute the file', async () => {
    // HTML is a supported document type — migration 0045 allowlists it and the OCR worker parses
    // it — so the upload is not refused. What is refused is rendering it in the Storage origin.
    for (const mime of ['text/html', 'TEXT/HTML', ' text/html ', 'application/xhtml+xml', 'image/svg+xml']) {
      mocks.createSignedUrl.mockClear();
      await signedDocumentSourceUrl('org/doc.html', 300, mime);
      expect(mocks.createSignedUrl).toHaveBeenCalledWith('org/doc.html', 300, { download: true });
    }
  });

  it('leaves every other document opening in the tab', async () => {
    for (const mime of ['application/pdf', 'image/png', 'text/csv', 'text/plain', null, undefined]) {
      mocks.createSignedUrl.mockClear();
      await signedDocumentSourceUrl('org/doc.pdf', 300, mime);
      expect(mocks.createSignedUrl).toHaveBeenCalledWith('org/doc.pdf', 300, undefined);
    }
  });

  it('reads the documents bucket unless the caller names another', async () => {
    await signedDocumentSourceUrl('org/doc.pdf', 600, 'application/pdf');
    expect(mocks.from).toHaveBeenCalledWith('documents');
    await signedDocumentSourceUrl('org/scan.png', 600, 'image/png', 'document-scans');
    expect(mocks.from).toHaveBeenLastCalledWith('document-scans');
  });

  it('throws rather than returning a blank tab when Storage refuses', async () => {
    mocks.createSignedUrl.mockResolvedValue({ data: null, error: { message: 'denied' } });
    await expect(signedDocumentSourceUrl('org/doc.pdf', 300, 'application/pdf')).rejects.toBeTruthy();
    mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: '' }, error: null });
    await expect(signedDocumentSourceUrl('org/doc.pdf', 300, 'application/pdf')).rejects.toBeTruthy();
  });

  it('names the executable types without guessing from the extension', () => {
    expect(rendersAsActiveContent('text/html')).toBe(true);
    expect(rendersAsActiveContent('text/htmlx')).toBe(false);
    expect(rendersAsActiveContent('')).toBe(false);
  });
});

describe('every raw-source popup goes through the helper', () => {
  // A fifth call site that builds its own signed URL would reopen the hole silently. The four
  // screens that show an original document are named here so adding one is a deliberate act.
  const callers = [
    'src/components/AttachmentsPanel.tsx',
    'src/components/FileUpload.tsx',
    'src/pages/DocumentsInbox.tsx',
    'src/components/document-review/DocumentReviewWorkspace.tsx',
  ];

  it('leaves no direct createSignedUrl against the documents bucket in a viewer', async () => {
    const { readFileSync } = await import('node:fs');
    for (const caller of callers) {
      const source = readFileSync(caller, 'utf8');
      expect(source, caller).toContain('signedDocumentSourceUrl(');
      // The plural `createSignedUrls` is deliberately still allowed: AttachmentsPanel batches
      // thumbnail links, and it renders those only for `image/*` rows, into an <img>.
      expect(source, caller).not.toContain("storage.from('documents').createSignedUrl(");
    }
  });
});
