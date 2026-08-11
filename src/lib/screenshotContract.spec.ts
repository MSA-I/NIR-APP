import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCREENSHOT_MAX_BYTES } from './screenshot';

/**
 * Package L, and specifically the parts of it that no runtime test can reach.
 *
 * html2canvas needs a renderer, and jsdom has none — a test that ran the real capture would be
 * measuring jsdom. What CAN be pinned, and what would be expensive to get wrong, is the set of
 * decisions the owner made on 11.08.2026 when choosing this mechanism over `getDisplayMedia`:
 * the picture never leaves the page, never includes the dialog, and never becomes a reason a
 * written note is lost.
 */
const read = (...parts: string[]) => readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');
const screenshot = read('lib', 'screenshot.ts');
const feedback = read('lib', 'feedback.ts');
const button = read('components', 'FeedbackButton.tsx');
const edge = readFileSync(
  join(process.cwd(), 'supabase', 'functions', 'send-feedback', 'index.ts'), 'utf8');

describe('the capture cannot reach outside this page', () => {
  it('uses a DOM renderer and never a display-media picker', () => {
    // This is the whole reason the owner chose it. getDisplayMedia would let a person hand a
    // vendor's Discord channel a screenshot of their bank, through nothing but a misclick in the
    // browser's own picker.
    expect(screenshot).toContain("import('html2canvas-pro')");
    // The unmaintained original throws on oklch, which is every colour token Tailwind v4 emits --
    // measured in the browser. Pinning the fork by name stops a well-meaning "the package without
    // the suffix is the real one" edit from silently disabling the whole feature.
    expect(screenshot).not.toContain("import('html2canvas')");
    // The call, not the word: the file's own header explains why getDisplayMedia was rejected, and
    // an assertion that forbade naming it would forbid explaining the decision.
    expect(screenshot).not.toContain('navigator.mediaDevices');
    expect(screenshot).not.toContain('getDisplayMedia(');
    expect(screenshot).not.toContain('getUserMedia(');
  });

  it('skips the dialog, opted-out elements and password fields', () => {
    expect(screenshot).toContain('[data-no-capture]');
    expect(screenshot).toContain('[role="dialog"]');
    expect(screenshot).toContain('input[type="password"]');
    expect(screenshot).toContain('ignoreElements');
  });

  it('leaves visibility to the renderer, in the layout context that can answer it', () => {
    // This assertion is inverted from what it was, and the inversion is the lesson. Filtering
    // elements by their computed style in the LIVE document broke the capture: the clone is laid
    // out in its own iframe, where `lg:hidden` phone chrome is visible and desktop chrome is not.
    // Measured on /documents at 2560px, the filter cut the picture down to the sidebar.
    expect(screenshot).not.toContain('getComputedStyle');
    expect(screenshot).toContain('ignoreElements: (element) => element.matches(SKIP_SELECTOR)');
  });

  it('captures the viewport rather than the whole document', () => {
    expect(screenshot).toContain('window.innerHeight');
    expect(screenshot).toContain('scale: 1');
  });

  it('caps at the size the bucket accepts, so an oversize capture is dropped not rejected', () => {
    // 0122's file_size_limit is 4 MiB. A client that uploaded past it would get a storage error
    // where the honest answer is "there is no picture".
    expect(SCREENSHOT_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(screenshot).toContain('blob.size > SCREENSHOT_MAX_BYTES');
  });
});

describe('a picture is never worth a lost sentence', () => {
  it('captures before the dialog opens', () => {
    // The ordering IS the guarantee that the dialog is not in the picture — stronger than asking
    // the library to skip it, because at capture time it does not exist yet.
    const order = button.indexOf('const openWithCapture');
    expect(order).toBeGreaterThan(-1);
    expect(button).toMatch(/await capture\(\);\s*\n\s*setOpen\(true\);/);
  });

  it('returns null rather than throwing, on every failure', () => {
    expect(screenshot).toContain('} catch {');
    expect(screenshot).toContain('return null;');
  });

  it('inserts the note before it touches storage', () => {
    const insert = feedback.indexOf(".from('feedback_notes')");
    const upload = feedback.indexOf(".storage.from('feedback')");
    expect(insert).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(insert);
  });

  it('reports "saved", "delivered" and "attached" as three separate truths', () => {
    expect(feedback).toContain('screenshotAttached');
    // The browser still cannot claim delivery: 0091's guarantee, unchanged by this package.
    expect(feedback).not.toContain('sent_at:');
  });
});

describe('the image has exactly one reader', () => {
  it('is fetched by the edge function on the service role, not by the browser', () => {
    expect(edge).toContain("admin.storage.from('feedback').download");
    expect(feedback).not.toContain('createSignedUrl');
    expect(feedback).not.toContain("storage.from('feedback').download");
  });

  it('posts it as multipart with mentions still disabled', () => {
    // A customer's note is untrusted text. Changing envelopes must not change that.
    expect(edge).toContain("form.append('files[0]'");
    expect(edge).toContain('allowed_mentions: { parse: [] }');
  });

  it('treats an unreadable image as a missing picture, not a failed delivery', () => {
    expect(edge).toContain('feedback screenshot unreadable');
    expect(edge).toMatch(/screenshot\s*=\s*null|let screenshot: Uint8Array \| null = null/);
  });
});
