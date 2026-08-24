import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  tusUpload: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    from: vi.fn(),
    storage: { from: vi.fn(() => ({ remove: vi.fn() })) },
    rpc: mocks.rpc,
  },
}));

vi.mock('../lib/tusUpload', () => ({
  TusUploadCancelledError: class TusUploadCancelledError extends Error {},
  TusUploadError: class TusUploadError extends Error {},
  tusUploadToDocuments: mocks.tusUpload,
}));

vi.mock('./UploadCenter', () => ({
  UploadCenter: () => null,
  claimActiveUploadTask: () => null,
  enqueueUploadCenterBatch: vi.fn(),
  getUploadCenterSnapshot: () => ({ entries: [] }),
  subscribeUploadCenter: () => () => {},
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', org_id: 'org-1', role: 'owner' } }),
}));

import { useQuickCapture } from './QuickCapture';

/* ---------- pixels, and the decode stubs that serve them ---------- */

function pixels(kind: 'sharp' | 'flat' | 'dark') {
  const width = 48;
  const height = 48;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const crisp = y % 4 === 0 || x % 5 === 0 ? 0 : 255;
      const value = kind === 'sharp' ? crisp : kind === 'flat' ? 210 : Math.round(crisp * 0.15);
      const p = (y * width + x) * 4;
      rgba[p] = value; rgba[p + 1] = value; rgba[p + 2] = value; rgba[p + 3] = 255;
    }
  }
  return { rgba, width, height };
}

/** Maps a picked file's name onto the pixels the decoder should hand back for it. */
function stubDecoder(byName: Record<string, 'sharp' | 'flat' | 'dark'>) {
  const buffers = new Map(Object.entries(byName).map(([name, kind]) => [name, pixels(kind)]));
  vi.stubGlobal('createImageBitmap', vi.fn(async (file: File) => ({
    width: 48, height: 48, close: vi.fn(), __name: file.name,
  })));
  vi.stubGlobal('OffscreenCanvas', class {
    name = '';
    constructor(readonly width: number, readonly height: number) {}
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        drawImage: (bitmap: { __name: string }) => { this.name = bitmap.__name; },
        getImageData: () => ({ data: buffers.get(this.name)!.rgba }),
      };
    }
  });
}

function Capture() {
  const { openCapture, element, busy } = useQuickCapture();
  return (
    <>
      <button type="button" onClick={openCapture}>צילום מסמך</button>
      <span data-testid="busy">{busy ? 'busy' : 'idle'}</span>
      {element}
    </>
  );
}

const Harness = () => <MemoryRouter><Capture /></MemoryRouter>;

/** The hidden input is display:none, so the pick is delivered the way the browser delivers it. */
function pick(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('[data-document-upload-input]')!;
  const list = { length: files.length, item: (i: number) => files[i] ?? null } as unknown as FileList;
  files.forEach((file, i) => { (list as unknown as Record<number, File>)[i] = file; });
  Object.defineProperty(input, 'files', { value: list, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input;
}

const photo = (name: string) => new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/jpeg' });

const uploadedFiles = () => mocks.tusUpload.mock.calls.map(([file]) => file as File);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.tusUpload.mockReturnValue({ done: Promise.resolve(), abort: vi.fn() });
  mocks.rpc.mockImplementation(async (name: string) => (name === 'register_uploaded_document'
    ? { data: { document_id: 'doc-1' }, error: null }
    : { data: { processing_job_id: 'job-1' }, error: null }));
});

afterEach(() => vi.unstubAllGlobals());

describe('QuickCapture quality warning', () => {
  it('uploads a good capture with no warning at all', async () => {
    stubDecoder({ 'good.jpg': 'sharp' });
    render(<Harness />);

    const file = photo('good.jpg');
    pick([file]);

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(uploadedFiles()[0]).toBe(file);
  });

  it('warns before uploading a blurred capture, and uploads nothing until the person decides', async () => {
    stubDecoder({ 'blurred.jpg': 'flat' });
    render(<Harness />);

    pick([photo('blurred.jpg')]);

    expect(await screen.findByText('התמונה יצאה מטושטשת')).toBeInTheDocument();
    expect(screen.getByText('כדאי לייצב את הטלפון ולצלם שוב.')).toBeInTheDocument();
    expect(mocks.tusUpload).not.toHaveBeenCalled();
  });

  it('names darkness, not blur, for an underexposed capture', async () => {
    stubDecoder({ 'night.jpg': 'dark' });
    render(<Harness />);

    pick([photo('night.jpg')]);

    expect(await screen.findByText('התמונה חשוכה מדי')).toBeInTheDocument();
    expect(screen.getByText('כדאי להוסיף אור ולצלם שוב.')).toBeInTheDocument();
  });

  /** The owner's ruling: WARN, do not block. This is the test that pins it. */
  it('"upload anyway" really uploads — the same File object, byte for byte', async () => {
    stubDecoder({ 'blurred.jpg': 'flat' });
    render(<Harness />);

    const file = photo('blurred.jpg');
    const before = new Uint8Array(await file.arrayBuffer());
    pick([file]);

    await userEvent.click(await screen.findByRole('button', { name: 'העלאה בכל זאת' }));

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(uploadedFiles()[0]).toBe(file);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(before);
    expect(file.size).toBe(before.byteLength);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('"re-take" uploads nothing and reopens the camera', async () => {
    stubDecoder({ 'blurred.jpg': 'flat' });
    render(<Harness />);
    pick([photo('blurred.jpg')]);
    const input = document.querySelector<HTMLInputElement>('[data-document-upload-input]')!;
    const reopen = vi.spyOn(input, 'click');

    await userEvent.click(await screen.findByRole('button', { name: 'צילום מחדש' }));

    await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
    expect(mocks.tusUpload).not.toHaveBeenCalled();
  });

  it('does not block the good captures in a mixed batch', async () => {
    stubDecoder({ 'good.jpg': 'sharp', 'blurred.jpg': 'flat' });
    render(<Harness />);

    const good = photo('good.jpg');
    const blurred = photo('blurred.jpg');
    pick([good, blurred]);

    // One weak capture out of two, so the title stays singular — and the list says which one.
    expect(await screen.findByText('התמונה יצאה מטושטשת')).toBeInTheDocument();
    expect(screen.getByText('blurred.jpg')).toBeInTheDocument();
    expect(screen.queryByText('good.jpg')).not.toBeInTheDocument();
    expect(screen.getByText('קובץ אחד תקין יעלה בכל מקרה.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'צילום מחדש' }));

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(uploadedFiles()).toEqual([good]);
  });

  it('turns plural, and counts the survivors, when several captures are weak', async () => {
    stubDecoder({ 'good.jpg': 'sharp', 'other.jpg': 'sharp', 'blurred.jpg': 'flat', 'night.jpg': 'dark' });
    render(<Harness />);

    pick([photo('good.jpg'), photo('other.jpg'), photo('blurred.jpg'), photo('night.jpg')]);

    expect(await screen.findByText('חלק מהתמונות לא יצאו טוב')).toBeInTheDocument();
    expect(screen.getByText('כדאי לצלם אותן שוב.')).toBeInTheDocument();
    expect(screen.getByText('מטושטשת')).toBeInTheDocument();
    expect(screen.getByText('חשוכה')).toBeInTheDocument();
    expect(screen.getByText('2').closest('.note-idle')).toBeInTheDocument();
  });

  it('uploads the whole mixed batch when the person insists', async () => {
    stubDecoder({ 'good.jpg': 'sharp', 'blurred.jpg': 'flat' });
    render(<Harness />);

    const good = photo('good.jpg');
    const blurred = photo('blurred.jpg');
    pick([good, blurred]);

    await userEvent.click(await screen.findByRole('button', { name: 'העלאה בכל זאת' }));

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(2));
    expect(uploadedFiles()).toEqual([good, blurred]);
  });

  it('uploads a PDF untouched — it is not a photograph and is never measured', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    render(<Harness />);

    const pdf = new File(['%PDF-1.7'], 'invoice.pdf', { type: 'application/pdf' });
    pick([pdf]);

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(decode).not.toHaveBeenCalled();
    expect(uploadedFiles()[0]).toBe(pdf);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uploads as usual when the measurement cannot run', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed'); }));
    render(<Harness />);

    const file = photo('unreadable.jpg');
    pick([file]);

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(uploadedFiles()[0]).toBe(file);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not silently upload HEIC when client decode fails; it names server preprocessing first', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported HEIC'); }));
    render(<Harness />);

    const heic = new File([new Uint8Array([1, 2, 3, 4])], 'IMG_0042.HEIC', {
      type: 'image/heic',
    });
    pick([heic]);

    expect(await screen.findByText('בדיקת התמונה תושלם בשרת')).toBeInTheDocument();
    expect(screen.getByText(/המקור יישמר ללא שינוי/)).toBeInTheDocument();
    expect(mocks.tusUpload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'שמירת המקור והמשך' }));
    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(uploadedFiles()[0]).toBe(heic);
    expect(mocks.rpc).toHaveBeenCalledWith('begin_document_intake', { p_document_id: 'doc-1' });
  });

  /**
   * #246 forbids two outcomes: silent upload without a check, and rejection. Closing the dialog
   * must not become the second one. The container is unreadable to this browser; the document
   * itself is intact, and the person who just photographed it gets no toast and no Upload Center
   * row to tell them it vanished.
   */
  it('closing the HEIC dialog still uploads the original — it is not a rejection', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported HEIC'); }));
    render(<Harness />);

    const heic = new File([new Uint8Array([1, 2, 3, 4])], 'IMG_0042.HEIC', { type: 'image/heic' });
    const before = new Uint8Array(await heic.arrayBuffer());
    pick([heic]);

    await userEvent.click(await screen.findByRole('button', { name: 'סגירה' }));

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(uploadedFiles()[0]).toBe(heic);
    expect(new Uint8Array(await heic.arrayBuffer())).toEqual(before);
    expect(mocks.rpc).toHaveBeenCalledWith('begin_document_intake', { p_document_id: 'doc-1' });
  });

  /** Another capture on an iPhone is another HEIC. Offering "re-take" here is an endless loop. */
  it('offers no re-take when only the format is unreadable', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported HEIC'); }));
    render(<Harness />);

    pick([new File([new Uint8Array([1, 2, 3, 4])], 'IMG_0042.HEIC', { type: 'image/heic' })]);

    expect(await screen.findByRole('button', { name: 'שמירת המקור והמשך' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'צילום מחדש' })).not.toBeInTheDocument();
  });

  it('a re-take drops the weak capture only — the HEIC beside it still uploads', async () => {
    const flat = pixels('flat');
    vi.stubGlobal('createImageBitmap', vi.fn(async (file: File) => {
      if (/\.heic$/i.test(file.name)) throw new Error('unsupported HEIC');
      return { width: 48, height: 48, close: vi.fn() };
    }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(readonly width: number, readonly height: number) {}
      getContext() {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: () => {},
          getImageData: () => ({ data: flat.rgba }),
        };
      }
    });
    render(<Harness />);

    const blurred = photo('blurred.jpg');
    const heic = new File([new Uint8Array([1, 2, 3, 4])], 'IMG_0042.HEIC', { type: 'image/heic' });
    pick([blurred, heic]);

    expect(await screen.findByText('התמונה יצאה מטושטשת')).toBeInTheDocument();
    expect(screen.getByText(/המקור יועלה כפי שהוא/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'צילום מחדש' }));

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(uploadedFiles()).toEqual([heic]);
  });
});
