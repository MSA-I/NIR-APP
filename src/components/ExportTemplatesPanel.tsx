import { useT } from '../lib/i18n/LocaleProvider';
import { useCallback, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import {
  EXPORT_DEFINITIONS,
  suggestMapping,
  unmappedCount,
  type ExportDefinition,
  type PlaceholderMapping,
} from '../lib/exportTemplates';
import {
  WORKBOOK_MIME_TYPES,
  WORKBOOK_REJECTION_KEY,
  WorkbookRejected,
  parseTemplateWorkbook,
  type ParsedWorkbook,
} from '../lib/exportTemplateWorkbook';
import { ErrorNote, ICON, Modal, Note, SubPanel, useToast } from './ui';

/**
 * Package K's screen: the accountant's own workbook becomes the export.
 *
 * The owner asked for a DEDICATED upload button, and that is the shape of this panel — one row per
 * report, each with its own button, rather than a generic "templates" list a person has to reason
 * about. The question somebody arrives with is "how do I make the monthly report look like my
 * accountant's file", and the answer should be a button beside the words "דוח חודשי לרואה חשבון".
 *
 * FOUR STEPS, AND THE ORDER IS THE SAFETY. Propose a version (0126), upload the file to the tenant's
 * own folder in a private bucket (0122's pattern, 0123's bucket), record it against the unapproved
 * version (0123), and only then approve. Nothing is live until the last step, an approved version
 * can never have its file swapped, and the trigger 0126 adds refuses to approve one with no file at
 * all — so a half-finished attempt leaves a draft, never a template that renders nothing.
 *
 * THE MAPPING IS A PERSON'S. Exact key matches are pre-selected and everything else is left empty,
 * because the alternative — matching `{{total}}` to `net_total` because they look similar — puts the
 * wrong number in a cell on a file an accountant files with the tax authority, on a row that says
 * "matched" and invites nobody to look twice.
 */

interface LiveTemplate {
  found: boolean;
  export_key: string;
  version?: number;
  name?: string;
  workbook_name?: string;
  placeholders?: PlaceholderMapping[];
}

interface Draft {
  definition: ExportDefinition;
  fileName: string;
  file: File;
  parsed: ParsedWorkbook;
  mapping: PlaceholderMapping[];
  name: string;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function ExportTemplatesPanel({ orgId }: { orgId: string }) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, error, refetch } = useQuery<LiveTemplate[]>(async () => Promise.all(
    EXPORT_DEFINITIONS.map(async (definition) =>
      unwrap(await supabase.rpc('resolve_export_report_template', {
        p_export_key: definition.key,
      })) as LiveTemplate)), []);

  /** Read and check the file in the browser, before anything is proposed or uploaded. */
  const chooseFile = useCallback(async (definition: ExportDefinition, file: File | undefined) => {
    if (!file) return;
    setRejection(null);
    try {
      const parsed = parseTemplateWorkbook(file.name, await file.arrayBuffer());
      setDraft({
        definition,
        file,
        fileName: file.name,
        parsed,
        mapping: suggestMapping(parsed.placeholders, definition),
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 120) || definition.title,
      });
    } catch (caught) {
      // A rejected workbook is not an error state of the panel — it is an answer, and it names what
      // to do next. See WORKBOOK_REJECTION_KEY.
      setRejection(caught instanceof WorkbookRejected ? t(WORKBOOK_REJECTION_KEY[caught.reason]) : errorText(caught));
    }
  }, [errorText, t]);

  const submit = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const proposed = unwrap(await supabase.rpc('propose_export_report_template', {
        p_export_key: draft.definition.key,
        p_name: draft.name.trim() || draft.definition.title,
        p_reason: `העלאת תבנית ל${draft.definition.title}`,
      })) as { version_id: string };

      // {org_id}/… — the prefix 0123's storage policy reads out of the path and compares.
      const path = `${orgId}/${proposed.version_id}.xlsx`;
      const uploaded = await supabase.storage.from('export-templates')
        .upload(path, draft.file, { contentType: draft.file.type, upsert: true });
      if (uploaded.error) throw uploaded.error;

      unwrap(await supabase.rpc('attach_export_template_workbook', {
        p_version_id: proposed.version_id,
        p_path: path,
        p_name: draft.fileName,
        p_bytes: draft.file.size,
        p_checksum: await sha256Hex(draft.file),
        p_mime: draft.file.type,
        p_sheets: draft.parsed.sheets,
        p_placeholders: draft.mapping,
        p_reason: `צירוף החוברת ${draft.fileName}`,
      }));

      unwrap(await supabase.rpc('approve_document_export_template_version', {
        p_version_id: proposed.version_id,
        p_reason: `אישור תבנית ל${draft.definition.title}`,
      }));

      toast(t('exportPanel.toast'), 'success');
      setDraft(null);
      await refetch();
    } catch (caught) {
      toast(errorText(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [draft, orgId, toast, refetch]);

  const pending = draft ? unmappedCount(draft.mapping) : 0;

  return (
    <div className="card card-pad space-y-4">
      <div>
        <h2 className="section-title flex items-center gap-2">
          <FileSpreadsheet size={ICON.md} aria-hidden="true" /> {t('exportPanel.heading')}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {t('exportPanel.intro')}
        </p>
      </div>

      {error && <ErrorNote message={error} />}
      {rejection && <Note tone="alert" role="alert">{rejection}</Note>}

      <ul className="divide-y divide-line-soft">
        {EXPORT_DEFINITIONS.map((definition) => {
          const live = data?.find((row) => row.export_key === definition.key);
          return (
            <li key={definition.key} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-48 grow">
                <div className="font-medium text-ink">{t(definition.titleKey)}</div>
                <div className="mt-0.5 text-sm text-ink-muted">{t(definition.descriptionKey)}</div>
                {/* What is live, said plainly. "אין תבנית" is a state, not a warning: the standard
                    export is a working answer and this panel is an improvement on it. */}
                <div className="mt-1 flex items-center gap-1.5 text-sm">
                  {live?.found ? (
                    <>
                      <CheckCircle2 size={ICON.sm} aria-hidden="true" className="text-done-fg" />
                      <span className="text-ink-body">
                        {live.name} · <span dir="ltr">{live.workbook_name}</span>{' '}
                        · {t('exportPanel.versionWord')} <span className="num">{live.version}</span>
                      </span>
                    </>
                  ) : (
                    <span className="text-ink-muted">{t('exportPanel.text_4')}</span>
                  )}
                </div>
              </div>
              <label className="btn-secondary min-h-11 cursor-pointer">
                <Upload size={ICON.sm} aria-hidden="true" />
                {live?.found ? t('exportPanel.text_5') : t('exportPanel.text_6')}
                <input type="file" className="sr-only" accept={WORKBOOK_MIME_TYPES.join(',')}
                  disabled={busy}
                  onChange={(event) => {
                    void chooseFile(definition, event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }} />
              </label>
            </li>
          );
        })}
      </ul>

      <Modal open={Boolean(draft)} onClose={() => setDraft(null)} busy={busy} wide
        title={draft ? t('exportPanel.modalTitleFor', { report: t(draft.definition.titleKey) }) : t('exportPanel.modalTitle')}
        description={t('exportPanel.modalDescription')}>
        {draft && (
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="template-name">{t('exportPanel.text_7')}</label>
              <input id="template-name" className="input" maxLength={120} value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>

            <SubPanel>
              <h3 className="text-sm font-medium text-ink">{t('exportPanel.text_8')}</h3>
              <ul className="mt-2 space-y-1 text-sm text-ink-body">
                {draft.parsed.sheets.map((sheet) => (
                  <li key={sheet.name}>
                    · {sheet.name} — <span className="num">{sheet.rows}</span> {t('exportPanel.rowsWord')}
                    <span className="num"> {sheet.columns}</span> {t('exportPanel.columnsWord')}
                    {sheet.headers.length > 0 && ` · ${sheet.headers.slice(0, 6).join(' | ')}`}
                  </li>
                ))}
              </ul>
              {draft.parsed.namedRanges.length > 0 && (
                <p className="mt-2 text-xs text-ink-muted">
                  {t('exportPanel.namedRanges', { ranges: draft.parsed.namedRanges.join(', ') })}
                </p>
              )}
            </SubPanel>

            {draft.mapping.length === 0 ? (
              <Note tone="await" role="status">
                <span className="min-w-0 flex-1">
                  {t('exportPanel.noPlaceholdersLead')} <span dir="ltr">{'{{field}}'}</span>{' '}
                  {t('exportPanel.noPlaceholdersMiddle')} <span dir="ltr">{'{{net_total}}'}</span>{' '}
                  {t('exportPanel.noPlaceholdersEnd')}
                </span>
              </Note>
            ) : (
              <div>
                <h3 className="text-sm font-medium text-ink">{t('exportPanel.text_9')}</h3>
                <ul className="mt-2 space-y-2">
                  {draft.mapping.map((row, index) => (
                    <li key={`${row.sheet}-${row.cell}-${index}`}
                      className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-40 text-ink-body">
                        <span dir="ltr">{`{{${row.key}}}`}</span>
                        <span className="text-ink-muted"> · {row.sheet}!<span className="num">{row.cell}</span></span>
                      </span>
                      <select className="input w-auto! min-h-11" value={row.source ?? ''}
                        aria-label={t('exportPanel.mappingAria', { placeholder: row.key })}
                        onChange={(event) => setDraft({
                          ...draft,
                          mapping: draft.mapping.map((current, position) => position === index
                            ? { ...current, source: event.target.value || null }
                            : current),
                        })}>
                        <option value="">{t('exportPanel.text_10')}</option>
                        {draft.definition.fields.map((field) => (
                          <option key={field.key} value={field.key}>
                            {t(field.labelKey)} ({t(field.sampleKey)})
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
                {pending > 0 && (
                  <p className="mt-2 text-xs text-ink-muted">
                    <span className="num">{pending}</span> {t('exportPanel.pendingPlaceholders')}{' '}
                    {t('exportPanel.text_11')}
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary min-h-11" disabled={busy}
                onClick={() => setDraft(null)}>{t('exportPanel.setDraft')}</button>
              <button type="button" className="btn-primary min-h-11" disabled={busy}
                onClick={() => void submit()}>
                  {busy && <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />}
                {t('exportPanel.text_12')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
