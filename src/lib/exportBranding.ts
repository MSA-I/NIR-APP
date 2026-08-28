import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { DOMAIN, key } from './query/keys';
import { useOrgScope } from './query/orgScope';

/**
 * Whether this organisation's generated PDFs carry the InPlace mark.
 *
 * The answer comes from the server (`public.my_export_watermark`, 0213), which resolves the
 * `exports.unbranded_pdf` entitlement through override then plan. It is deliberately NOT a
 * `plan_key === 'free'` test in the client: 0154 built one place where "what does this plan
 * include" is answered, and a second one here would be invisible to a platform override and wrong
 * the day a rung is added.
 *
 * BEFORE THE ANSWER ARRIVES, AND IF IT NEVER DOES, THE MARK IS APPLIED. That matches the server's
 * own refusal direction: an unstated grant withholds the benefit. It is the cheap failure — a
 * stamped document is still a complete, correct document, while the opposite default would hand
 * out the paid appearance to anyone whose network call failed.
 *
 * AND IT IS BRANDING, NOT ACCESS CONTROL. The generator runs in the browser, so a determined
 * reader can strip the stamp. Enforcing it would mean generating the document server-side, which
 * is a different piece of work; nothing here should be read as a claim that it is enforced.
 */
export function useExportWatermark(): boolean {
  const org = useOrgScope();
  const query = useQuery({
    queryKey: key(org, DOMAIN.subscription, 'export-watermark'),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_export_watermark');
      if (error) throw error;
      return data === true;
    },
  });
  return query.data ?? true;
}
