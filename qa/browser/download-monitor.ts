import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Download, Page } from '@playwright/test';
import { redactText, safeArtifactName } from './redaction.ts';

export interface DownloadEvidence {
  readonly fileName: string;
  readonly path: string | null;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly failure: string | null;
}

export class DownloadMonitor {
  readonly entries: DownloadEvidence[] = [];
  private readonly page: Page;
  private readonly outputDirectory: string;
  private readonly captures = new WeakMap<Download, Promise<DownloadEvidence>>();
  private readonly pending = new Set<Promise<DownloadEvidence>>();
  private sequence = 0;
  private readonly onDownload = (download: Download): void => {
    void this.persist(download);
  };

  constructor(page: Page, outputDirectory: string) {
    this.page = page;
    this.outputDirectory = outputDirectory;
    page.on('download', this.onDownload);
  }

  async waitForNext(action: () => Promise<void>): Promise<DownloadEvidence> {
    const event = this.page.waitForEvent('download');
    await action();
    return this.persist(await event);
  }

  private persist(download: Download): Promise<DownloadEvidence> {
    const existing = this.captures.get(download);
    if (existing) return existing;
    const capture = this.save(download);
    this.captures.set(download, capture);
    this.pending.add(capture);
    return capture;
  }

  private async save(download: Download): Promise<DownloadEvidence> {
    await mkdir(this.outputDirectory, { recursive: true });
    const suggested = safeArtifactName(redactText(download.suggestedFilename()), 'download.bin');
    const fileName = `${String(++this.sequence).padStart(2, '0')}-${suggested}`;
    const path = join(this.outputDirectory, fileName);
    try {
      await download.saveAs(path);
      const bytes = (await stat(path)).size;
      const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
      const evidence = { fileName, path, bytes, sha256, failure: null } satisfies DownloadEvidence;
      this.entries.push(evidence);
      return evidence;
    } catch (error) {
      const evidence = {
        fileName,
        path: null,
        bytes: 0,
        sha256: null,
        failure: redactText(error instanceof Error ? error.message : String(error)),
      } satisfies DownloadEvidence;
      this.entries.push(evidence);
      return evidence;
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  async blockingIssues(): Promise<readonly string[]> {
    await this.flush();
    return this.entries
      .filter(({ failure, bytes }) => failure !== null || bytes === 0)
      .map(({ fileName, failure, bytes }) => `download ${fileName}: ${failure ?? `${bytes} bytes`}`);
  }

  stop(): void {
    this.page.off('download', this.onDownload);
  }
}
