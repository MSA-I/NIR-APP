import { Link } from 'react-router';
import { APP_NAME } from '../lib/branding';
import { useT } from '../lib/i18n/LocaleProvider';

/**
 * Terms of service + privacy policy (package 7, owner decision 09.08.2026: the agent drafts).
 *
 * The version is what a user consents TO: accept_invitation (0089) refuses to create a
 * profile without it, and stamps it into audit_logs. Changing the TEXT in any way that
 * matters legally must bump TERMS_VERSION — an unchanged version over changed terms would
 * make every stored consent a lie.
 *
 * Drafted with the requirements of תיקון 13 לחוק הגנת הפרטיות (in force 14.08.2025) in view:
 * what is collected, for what purpose, on what legal basis, who processes it, and the data
 * subject's rights. Two honest gaps are recorded in OPEN-DECISIONS: the operator's legal
 * identity/contact details are placeholders the owner must fill before marketing the
 * product, and this drafting is NOT legal advice — a lawyer's review is the owner's call.
 *
 * 2026-08-24 — version bumped for one deletion: the privacy policy used to state flatly that a
 * document sent for interpretation is not stored at the model provider. `store: false` is an API
 * REQUEST, not the provider's undertaking — docs/ASSISTANT.md §5.1 says so in the same repository —
 * and OPEN-DECISIONS #179 forbids promising zero retention without a contract that proves it. A
 * consent document is the last place a promise nobody can back belongs, so the sentence now says
 * what the system actually does and what it does not know.
 *
 * 2026-08-24, same version, second change — and deliberately the SAME version rather than a second
 * bump. The deletion above shipped nowhere: it was merged and never deployed, so no consent was
 * ever stamped against the intermediate text. The version a user will actually consent to is this
 * one, and stamping two different documents with one string is only a lie if both were served.
 *
 * What this change adds is section 3, and it exists because the #179 evidence was finally gathered
 * from OpenAI's own dated pages (docs/ASSISTANT-ACTIVATION-EVIDENCE.md §1). Removing a promise we
 * could not keep was half the work; the other half is saying what actually happens. Three facts a
 * reader has no way to discover and every right to know: inputs may be retained for up to 30 days
 * with two open-ended extensions in the provider's own wording; those abuse logs are readable by
 * the provider's authorised employees AND by third-party contractors; and no regional restriction
 * is configured, Israel is not even an available region, and provider-side "system data" leaves any
 * region regardless. Section 2 keeps the sub-processor list; the provider-side facts get their own
 * heading rather than a clause at the end of a dense paragraph, because a disclosure buried in
 * prose is the same half-truth in a politer form.
 *
 * 2026-08-28 — TWO BINDING VERSIONS, one per language. Owner decision, OPEN-DECISIONS #280,
 * chosen over both cheaper readings after all three were spelled out: serving the Hebrew document
 * to everyone, or translating for convenience while the Hebrew governs. Neither was chosen.
 *
 * What that means for whoever edits this file next, and it is the whole of the decision:
 *
 *   * There is NO sentence anywhere saying the Hebrew governs, and adding one would contradict
 *     the decision rather than clarify it. Somebody who signed in English agreed to the English
 *     text, and that is the text they must be shown if they ask what they agreed to.
 *   * Every future amendment is TWO legal amendments and needs review of BOTH. A gap between the
 *     two versions is not a wording slip — it is two different undertakings. The owner accepted
 *     that price explicitly.
 *   * The wording lives in the `legal` namespace of both dictionaries rather than in this file.
 *     `apply-ns.mjs` refuses a namespace where a key exists on one side only, so a half-translated
 *     document cannot compile, and `en.ts` is type-checked key-for-key against `he.ts`.
 *   * `TERMS_VERSION` is bumped, because the English document is new text that people will
 *     consent to. The header rule above applies to it exactly as it applies to the Hebrew.
 *
 * The drafting caveat has NOT gone away and matters more now, not less: this is not legal advice,
 * a lawyer's review is the owner's call, and there are now two documents to review. `GATES.md`
 * P2-G9 must not be marked met on a green test run.
 *
 * Spacing between a bold label and the sentence after it is `{' '}` in the markup rather than a
 * space baked into the dictionary value. A leading or trailing space inside a translated string
 * is invisible in review and disappears on the first well-meaning trim.
 */
export const TERMS_VERSION = '2026-08-28';

/**
 * The reading shell, ported from the marketing site's /terms and /privacy (owner instruction,
 * 28.08.2026). It is the one page in the signed-in product that is a DOCUMENT rather than a
 * screen: a 44rem measure on the navigation shell's own Onyx, a sticky bar that spans the window
 * while its contents keep the column, and no card — a card frames a working surface, and there is
 * nothing here to work with.
 *
 * The lockup is the product's mark, not this document's title. It used to be the page's only
 * <h1>, which left the actual subject as an <h2> with no h1 above it. The mark keeps its alt text
 * and stops being a heading; the title is the h1 and the clauses are h2, so the outline has no
 * skipped level.
 *
 * Only the SHELL was ported. The marketing site's lede says the Hebrew version is the one that
 * governs, and `OPEN-DECISIONS #280` retired that sentence: both versions bind. Copying the look
 * and the copy together would have quietly reinstated the reading the owner did not choose.
 */
function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useT();
  return (
    <div className="legal-doc">
      <header className="legal-doc__bar">
        <div className="legal-doc__column legal-doc__bar-in">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="166" height="36"
            className="h-auto w-32" />
          <nav className="legal-doc__nav" aria-label={t('legal.navLabel')}>
            <Link to="/terms">{t('legal.linkTerms')}</Link>
            <Link to="/privacy">{t('legal.linkPrivacy')}</Link>
            <Link to="/login">{t('legal.linkLogin')}</Link>
          </nav>
        </div>
      </header>
      <main className="legal-doc__column">
        <p className="legal-doc__eyebrow">{t('legal.eyebrow')}</p>
        <h1>{title}</h1>
        <p className="legal-doc__version">{t('legal.version', { version: TERMS_VERSION })}</p>
        {children}
        <div className="legal-doc__foot">
          <Link to="/terms">{t('legal.linkTerms')}</Link>
          <Link to="/privacy">{t('legal.linkPrivacy')}</Link>
          <Link to="/login">{t('legal.linkLogin')}</Link>
        </div>
      </main>
    </div>
  );
}

export function TermsOfService() {
  const { t } = useT();
  return (
    <LegalShell title={t('legal.termsTitle')}>
      <section className="legal-doc__section">
        <h2>{t('legal.terms1Title')}</h2>
        <p>{t('legal.terms1Body', { app: APP_NAME })}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.terms2Title')}</h2>
        <p>{t('legal.terms2Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.terms3Title')}</h2>
        <p>{t('legal.terms3Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.terms4Title')}</h2>
        <p>{t('legal.terms4Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.terms5Title')}</h2>
        <p>{t('legal.terms5Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.terms6Title')}</h2>
        <p>{t('legal.terms6Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.terms7Title')}</h2>
        <p>{t('legal.terms7Body')}</p>
      </section>
    </LegalShell>
  );
}

export function PrivacyPolicy() {
  const { t } = useT();
  return (
    <LegalShell title={t('legal.privacyTitle')}>
      <section className="legal-doc__section">
        <h2>{t('legal.privacy1Title')}</h2>
        <p>
          <strong>{t('legal.privacy1AccountLabel')}</strong>{' '}{t('legal.privacy1AccountBody')}{' '}
          <strong>{t('legal.privacy1BusinessLabel')}</strong>{' '}{t('legal.privacy1BusinessBody')}{' '}
          <strong>{t('legal.privacy1AuditLabel')}</strong>{' '}{t('legal.privacy1AuditBody')}{' '}
          <strong>{t('legal.privacy1TechnicalLabel')}</strong>{' '}{t('legal.privacy1TechnicalBody')}
        </p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.privacy2Title')}</h2>
        <p>{t('legal.privacy2Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.privacy3Title')}</h2>
        <p>{t('legal.privacy3Intro')}</p>
        <p>
          <strong>{t('legal.privacy3TrainingLabel')}</strong>{' '}{t('legal.privacy3TrainingBody')}{' '}
          <strong>{t('legal.privacy3RetentionLabel')}</strong>{' '}{t('legal.privacy3RetentionLead')}{' '}
          <strong>{t('legal.privacy3RetentionWindow')}</strong>{' '}{t('legal.privacy3RetentionTail')}{' '}
          <strong>{t('legal.privacy3ReviewLabel')}</strong>{' '}{t('legal.privacy3ReviewLead')}{' '}
          <strong>{t('legal.privacy3ReviewContractors')}</strong>{' '}{t('legal.privacy3ReviewTail')}
        </p>
        <p>
          <strong>{t('legal.privacy3AsksLabel')}</strong>{' '}{t('legal.privacy3AsksLead')}{' '}
          <strong>{t('legal.privacy3AsksNot')}</strong>{' '}{t('legal.privacy3AsksMiddle')}{' '}
          <strong>{t('legal.privacy3AsksPromise')}</strong>{t('legal.privacy3AsksEnd')}
        </p>
        <p>
          <strong>{t('legal.privacy3LocationLabel')}</strong>{' '}{t('legal.privacy3LocationBody')}
        </p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.privacy4Title')}</h2>
        <p>{t('legal.privacy4Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.privacy5Title')}</h2>
        <p>{t('legal.privacy5Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.privacy6Title')}</h2>
        <p>{t('legal.privacy6Body')}</p>
      </section>
      <section className="legal-doc__section">
        <h2>{t('legal.privacy7Title')}</h2>
        <p>{t('legal.privacy7Body')}</p>
      </section>
    </LegalShell>
  );
}
