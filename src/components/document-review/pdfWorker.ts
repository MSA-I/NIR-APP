import { pdfjs } from 'react-pdf';
// The worker MUST come from the same pdfjs-dist copy react-pdf resolved (5.4.296, pinned by
// react-pdf@10.4.1) — a separately installed pdfjs-dist would be a second copy and a worker/API
// version mismatch (THIRD_PARTY_NOTICES.md). `?url` lets Vite emit the module as an asset and
// hand back its URL, so pdf.js gets a real worker instead of the slow same-thread "fake worker"
// fallback (which also logs the warning the quality gate treats as a failure).
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
