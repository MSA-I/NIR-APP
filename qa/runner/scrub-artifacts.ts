import { access, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { scrubTraceZip } from '../reporting/scrub-traces.ts';

async function traceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await traceFiles(target));
    else if (entry.isFile() && entry.name === 'trace.zip') result.push(target);
  }
  return result;
}

export async function scrubPlaywrightTraces(artifactRoot: string): Promise<string[]> {
  const root = path.resolve(artifactRoot);
  const traces = await traceFiles(root);
  for (const trace of traces) {
    const relative = path.relative(root, trace);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to scrub a trace outside the managed artifact root.');
    }
    const temporary = trace + '.redacted';
    try {
      await scrubTraceZip(trace, temporary);
      await rm(trace, { force: false });
      await rename(temporary, trace);
    } catch (error) {
      // Fail closed: once any trace cannot be proven redacted, retain no trace archive from
      // this run. This also removes later raw traces that were not processed yet.
      await Promise.allSettled(traces.flatMap((candidate) => [
        rm(candidate, { force: true }).catch(() => undefined),
        rm(candidate + '.redacted', { force: true }).catch(() => undefined),
      ]));
      const retained: string[] = [];
      for (const candidate of traces.flatMap((value) => [value, value + '.redacted'])) {
        try {
          await access(candidate);
          retained.push(candidate);
        } catch (accessError) {
          if ((accessError as NodeJS.ErrnoException).code !== 'ENOENT') retained.push(candidate);
        }
      }
      if (retained.length > 0) {
        throw new AggregateError([error], 'Trace redaction failed and raw trace deletion could not be verified.');
      }
      throw error;
    }
  }
  return traces.map((trace) => path.relative(root, trace).replaceAll('\\', '/'));
}
