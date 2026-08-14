import { useEffect, useMemo } from 'react';
import { supabase } from './supabase';
import { useQuery } from './useQuery';

export type DocumentScanStatus =
  | 'queued'
  | 'processing'
  | 'needs_corners'
  | 'ready'
  | 'accepted'
  | 'failed';

export type ScanPoint = [x: number, y: number];
export type ScanCorners = [ScanPoint, ScanPoint, ScanPoint, ScanPoint];

export interface DocumentScanState {
  document_id: string;
  scan_job_id: string;
  processing_job_id: string;
  status: DocumentScanStatus;
  requested_mode: 'auto' | 'grayscale' | 'black_and_white';
  manual_corners: ScanCorners | null;
  last_error_code: string | null;
  last_error_message: string | null;
  output_id: string | null;
  output_storage_path: string | null;
  output_mode: 'grayscale' | 'black_and_white' | null;
  detected_corners: ScanCorners | null;
  corners_source: 'automatic' | 'manual' | null;
  rotation_degrees: number | null;
  accepted: boolean;
  updated_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set<DocumentScanStatus>([
  'queued', 'processing', 'needs_corners', 'ready', 'accepted', 'failed',
]);

export function scanCornersValid(value: unknown): value is ScanCorners {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((point) =>
    Array.isArray(point) && point.length === 2 && point.every((coordinate) =>
      typeof coordinate === 'number' && Number.isFinite(coordinate)
      && coordinate >= 0 && coordinate <= 1
    )
  )) return false;
  const corners = value as ScanCorners;
  const area = Math.abs(corners.reduce((sum, point, index) => {
    const next = corners[(index + 1) % corners.length];
    return sum + point[0] * next[1] - point[1] * next[0];
  }, 0)) / 2;
  const crosses = corners.map((point, index) => {
    const next = corners[(index + 1) % corners.length];
    const after = corners[(index + 2) % corners.length];
    return (next[0] - point[0]) * (after[1] - next[1])
      - (next[1] - point[1]) * (after[0] - next[0]);
  });
  return area >= 0.08
    && (crosses.every((cross) => cross > 0) || crosses.every((cross) => cross < 0));
}

function parseState(value: unknown): DocumentScanState | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.document_id !== 'string' || !UUID.test(row.document_id)
      || typeof row.scan_job_id !== 'string' || !UUID.test(row.scan_job_id)
      || typeof row.processing_job_id !== 'string' || !UUID.test(row.processing_job_id)
      || typeof row.status !== 'string' || !STATUSES.has(row.status as DocumentScanStatus)
      || typeof row.requested_mode !== 'string'
      || !['auto', 'grayscale', 'black_and_white'].includes(row.requested_mode)
      || !(row.manual_corners === null || scanCornersValid(row.manual_corners))
      || !(row.detected_corners === null || scanCornersValid(row.detected_corners))
      || !(row.last_error_code === null || typeof row.last_error_code === 'string')
      || !(row.last_error_message === null || typeof row.last_error_message === 'string')
      || !(row.output_id === null || (typeof row.output_id === 'string' && UUID.test(row.output_id)))
      || !(row.output_storage_path === null || typeof row.output_storage_path === 'string')
      || !(row.output_mode === null || row.output_mode === 'grayscale' || row.output_mode === 'black_and_white')
      || !(row.corners_source === null || row.corners_source === 'automatic' || row.corners_source === 'manual')
      || !(row.rotation_degrees === null || (typeof row.rotation_degrees === 'number'
        && Number.isFinite(row.rotation_degrees) && row.rotation_degrees >= -7 && row.rotation_degrees <= 7))
      || typeof row.accepted !== 'boolean'
      || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) return null;
  const hasOutput = row.output_id !== null && row.output_storage_path !== null
    && row.output_mode !== null && row.detected_corners !== null
    && row.corners_source !== null && row.rotation_degrees !== null;
  if ((row.status === 'ready' || row.status === 'accepted') !== hasOutput
      || row.accepted !== (row.status === 'accepted')) return null;
  return row as unknown as DocumentScanState;
}

async function fetchStates(documentIds: string[]): Promise<Record<string, DocumentScanState>> {
  if (!documentIds.length) return {};
  const response = await supabase.rpc('get_document_scan_states', { p_document_ids: documentIds });
  if (response.error) {
    if (response.error.code === 'PGRST202' || response.error.code === '42883') return {};
    throw response.error;
  }
  if (!Array.isArray(response.data)) throw new Error('invalid_document_scan_states');
  const states: Record<string, DocumentScanState> = {};
  for (const value of response.data) {
    const state = parseState(value);
    if (!state) throw new Error('invalid_document_scan_state');
    states[state.document_id] ??= state;
  }
  return states;
}

export function useDocumentScanning(documentIds: string[]) {
  const key = useMemo(() => [...new Set(documentIds)].sort().join('|'), [documentIds]);
  const ids = useMemo(() => key ? key.split('|') : [], [key]);
  const query = useQuery(() => fetchStates(ids), [key]);
  const states = query.data ?? {};

  const polling = Object.values(states).some((state) =>
    state.status === 'queued' || state.status === 'processing'
  );
  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => { void query.refetch(); }, 2500);
    return () => window.clearInterval(timer);
  }, [polling, query.refetch]);

  return { ...query, states };
}

export async function submitDocumentScanCorners(scanJobId: string, corners: ScanCorners) {
  const response = await supabase.rpc('submit_document_scan_corners', {
    p_scan_job_id: scanJobId,
    p_corners: corners,
  });
  if (response.error) throw response.error;
  return response.data;
}

export async function recoverDocumentScan(scanJobId: string, corners: ScanCorners) {
  const response = await supabase.rpc('recover_document_scan', {
    p_scan_job_id: scanJobId,
    p_corners: corners,
    p_reason: 'manual boundary correction after scan review',
  });
  if (response.error) throw response.error;
  return response.data;
}

export async function acceptDocumentScan(outputId: string) {
  const response = await supabase.rpc('accept_document_scan', { p_scan_output_id: outputId });
  if (response.error) throw response.error;
  return response.data;
}
