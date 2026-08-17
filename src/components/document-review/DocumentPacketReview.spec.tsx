import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DocumentProcessingSnapshot } from '../../lib/useDocumentProcessing';

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc, functions: { invoke } },
}));

import { DocumentPacketReview } from './DocumentPacketReview';

function packetSnapshot(
  status: 'needs_review' | 'approved' | 'materialized' = 'needs_review',
  childDocumentId: string | null = null,
): DocumentProcessingSnapshot {
  return {
    documentId: 'parent-document',
    stage: 'review',
    document: {
      id: 'parent-document', org_id: 'org-1', unit_id: null, entity_type: 'inbox',
      entity_id: null, storage_path: 'org-1/source.pdf', file_name: 'source.pdf',
      mime_type: 'application/pdf', document_kind: 'other', uploaded_by: 'owner-1',
      supplier_id: null, document_date: null, deleted_at: null, created_at: '2026-08-17T00:00:00Z',
    },
    job: null, jobs: [], extraction: null, extractions: [], interpretation: null,
    interpretations: [], annotations: [], ruleApplications: [], learningRules: [],
    reviewCorrections: [], typeReviewDecisions: [], filings: [], feedback: [],
    exportTemplates: [], exportTemplateVersions: [], exports: [], actorNames: new Map(),
    priceListDecision: null, priceListLines: [],
    packet: {
      id: 'packet-1', org_id: 'org-1', unit_id: null, parent_document_id: 'parent-document',
      source_job_id: 'job-1', source_interpretation_id: 'interpretation-1', page_count: 4,
      source_partial: false, confidence_threshold: 0.9, automatic_eligible: false,
      status, manifest_hash: 'a'.repeat(64), manifest_version: 1, created_by: 'owner-1',
      approved_by: status === 'needs_review' ? null : 'owner-1',
      approved_at: status === 'needs_review' ? null : '2026-08-17T00:00:00Z',
      approval_reason: status === 'needs_review' ? null : 'אישור בדיקה',
      failure_code: null, failure_message: null, created_at: '2026-08-17T00:00:00Z',
      updated_at: '2026-08-17T00:00:00Z',
    },
    packetSegments: [
      {
        id: 'segment-1', org_id: 'org-1', unit_id: null, packet_id: 'packet-1', ordinal: 1,
        start_page: 1, end_page: 2, document_type: 'delivery_note', confidence: 0.97,
        child_document_id: childDocumentId, storage_path: childDocumentId ? 'org-1/child-1.pdf' : null,
        created_at: '2026-08-17T00:00:00Z', materialized_at: childDocumentId ? '2026-08-17T00:00:00Z' : null,
      },
      {
        id: 'segment-2', org_id: 'org-1', unit_id: null, packet_id: 'packet-1', ordinal: 2,
        start_page: 3, end_page: 4, document_type: 'invoice', confidence: 0.96,
        child_document_id: null, storage_path: null, created_at: '2026-08-17T00:00:00Z', materialized_at: null,
      },
    ],
  } as unknown as DocumentProcessingSnapshot;
}

function renderPacket(snapshot = packetSnapshot(), onRefetch = vi.fn(async () => true)) {
  return {
    onRefetch,
    ...render(<MemoryRouter><DocumentPacketReview snapshot={snapshot} readOnly={false} onRefetch={onRefetch} /></MemoryRouter>),
  };
}

describe('בדיקת חבילת מסמכים מעורבת', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
  });

  it('מאשר manifest מלא, שולח את ה-hash הצפוי ויוצר מסמכי בת', async () => {
    rpc.mockResolvedValueOnce({ data: { status: 'approved' }, error: null });
    invoke.mockResolvedValueOnce({ data: { status: 'materialized' }, error: null });
    const { onRefetch } = renderPacket();

    await userEvent.type(screen.getByLabelText('הערה ליומן הביקורת — רשות'), 'בדיקה ידנית');
    await userEvent.click(screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('approve_document_packet', {
      p_packet_id: 'packet-1',
      p_expected_manifest_hash: 'a'.repeat(64),
      p_segments: [
        { ordinal: 1, start_page: 1, end_page: 2, document_type: 'delivery_note', confidence: 0.97 },
        { ordinal: 2, start_page: 3, end_page: 4, document_type: 'invoice', confidence: 0.96 },
      ],
      p_reason: 'בדיקה ידנית',
    }));
    expect(invoke).toHaveBeenCalledWith('interpret-document', { body: { packetId: 'packet-1' } });
    expect(onRefetch).toHaveBeenCalledOnce();
  });

  it('מציג שגיאת stale ואינו מנסה materialization', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'document_packet_stale_context' } });
    renderPacket();
    await userEvent.click(screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('מציג קישור למסמך שנוצר אחרי materialization גם כשה-hash לא השתנה', () => {
    const view = renderPacket(packetSnapshot('approved'));
    expect(screen.queryByRole('link', { name: 'פתיחת המסמך שנוצר' })).toBeNull();
    view.rerender(
      <MemoryRouter><DocumentPacketReview snapshot={packetSnapshot('materialized', 'child-1')} readOnly={false} onRefetch={view.onRefetch} /></MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'פתיחת המסמך שנוצר' })).toHaveAttribute(
      'href', '/documents/child-1/review',
    );
  });
});
