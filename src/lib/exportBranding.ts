import { supabase } from './supabase';

/**
 * Whether this organisation's generated PDFs carry the InPlace mark.
 *
 * The answer comes from the server (`public.my_export_watermark`, 0213), which resolves the
 * `exports.unbranded_pdf` entitlement through override then plan. It is deliberately NOT a
 * `plan_key === 'free'` test in the client: 0154 built one place where "what does this plan
 * include" is answered, and a second one here would be invisible to a platform override and wrong
 * the day a rung is added.
 *
 * ASKED AT DOWNLOAD TIME, NOT AT RENDER TIME. This began as a `useQuery` hook and was wrong twice
 * over: every visit to an invoice, an order or a report fired a request for a fact that only
 * matters if somebody presses a button, and it broke the component tests, which is the same defect
 * from the other side — a screen that quietly grew a network dependency it does not need. One
 * round trip per export is not worth a hook.
 *
 * IF THE CALL FAILS, THE MARK IS APPLIED. That matches the server's own refusal direction: an
 * unstated grant withholds the benefit. It is the cheap failure — a stamped document is still a
 * complete, correct document, while the opposite default would hand out the paid appearance to
 * anyone whose network call failed.
 *
 * AND IT IS BRANDING, NOT ACCESS CONTROL. The generator runs in the browser, so a determined
 * reader can strip the stamp. Enforcing it would mean generating the document server-side, which
 * is a different piece of work; nothing here should be read as a claim that it is enforced.
 * `DEBT §69`.
 */
export async function exportWatermark(): Promise<boolean> {
  const { data, error } = await supabase.rpc('my_export_watermark');
  if (error) {
    console.error('[export-branding]', error.message);
    return true;
  }
  return data === true;
}
