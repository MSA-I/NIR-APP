const FIXTURE = Object.freeze({
  id: 'assistant-ui-review-20260820',
  question:
    'בדוק אילו חשבוניות נקלטו ב־7 הימים האחרונים, מה הסכום הפתוח מתוכן, ומה דורש טיפול לפני שאפשר להעביר אותן לרואה החשבון.',
  summary:
    'הבדיקה מצאה תמונה ברורה ברוב הנתונים, אך מקור אחד לא הושלם ולכן אי אפשר לקבוע שכל החשבוניות מוכנות להעברה.',
  asOf: '20.08.2026, 13:00',
  scope: '7 הימים האחרונים',
  claims: [
    {
      id: 'claim-invoice-count',
      title: 'קליטת חשבוניות',
      text: 'נקלטו 12 חשבוניות בחלון שנבדק.',
      factLabel: 'חשבוניות שנקלטו',
      factValue: '12',
      factUnit: 'חשבוניות',
      sourceId: 'source-invoices',
    },
    {
      id: 'claim-open-amount',
      title: 'סכום פתוח',
      text: 'הסכום הפתוח שנמדד בחשבוניות האלה הוא 18,430.60 ₪.',
      factLabel: 'יתרה פתוחה בחלון',
      factValue: '18,430.60 ₪',
      factUnit: 'לפני תשלום',
      sourceId: 'source-balances',
    },
    {
      id: 'claim-investigation',
      title: 'דורש טיפול',
      text: '3 חשבוניות דורשות בירור לפני שאפשר להעביר אותן לרואה החשבון.',
      factLabel: 'חשבוניות בבירור',
      factValue: '3',
      factUnit: 'חשבוניות',
      sourceId: 'source-exceptions',
    },
  ],
  sources: [
    {
      id: 'source-invoices',
      label: 'רשימת החשבוניות שנקלטו',
      route: '/invoices?received=last_7_days',
      eyebrow: 'מקור · חשבוניות',
      title: 'חשבוניות שנקלטו ב־7 הימים האחרונים',
      description: 'רשימה מסוננת לפי תאריך הקליטה הסמכותי של המערכת.',
      rows: [
        ['חלון', '14.08.2026–20.08.2026'],
        ['נמצאו', '12 חשבוניות'],
        ['סינון', 'תאריך קליטה'],
      ],
    },
    {
      id: 'source-balances',
      label: 'יתרות החשבוניות בחלון',
      route: '/invoices?balance=open',
      eyebrow: 'מקור · יתרות חשבונית',
      title: 'יתרה פתוחה בחשבוניות שנקלטו',
      description: 'סכומים שנמדדו בצד השרת מתוך החשבוניות שבחלון בלבד.',
      rows: [
        ['יתרה פתוחה', '18,430.60 ₪'],
        ['חשבוניות עם יתרה', '8'],
        ['עודכן', '20.08.2026, 13:00'],
      ],
    },
    {
      id: 'source-exceptions',
      label: 'חשבוניות שדורשות בירור',
      route: '/exceptions?entity=invoice',
      eyebrow: 'מקור · חריגי התאמה',
      title: 'חשבוניות שדורשות בירור',
      description: 'ממצאים מהתאמת הזמנה, קבלה וחשבונית. חלק אחד של הסריקה לא הושלם.',
      rows: [
        ['דורשות בירור', '3 חשבוניות'],
        ['התאמה מלאה', '9 חשבוניות'],
        ['כיסוי', 'חלקי'],
      ],
    },
  ],
  tools: [
    { label: 'חשבוניות שנקלטו', state: 'הושלם' },
    { label: 'יתרות חשבונית פתוחות', state: 'הושלם' },
    { label: 'התאמת הזמנה, קבלה וחשבונית', state: 'חלקי' },
  ],
});

const root = document.querySelector('[data-prototype-root]');
const panel = document.querySelector('[data-investigation-panel]');
const appShells = [...document.querySelectorAll('[data-app-shell]')];
const answerView = document.querySelector('[data-answer-view]');
const sourceView = document.querySelector('[data-source-view]');
const answerScroller = document.querySelector('[data-answer-scroller]');
const sourceHeading = document.querySelector('[data-source-view] [data-source-title]');
const liveRegion = document.querySelector('[data-live-region]');
const desktopQuery = window.matchMedia('(min-width: 1024px)');

let panelOpen = true;
let returnFocus = null;
let answerScrollTop = 0;
let activeSourceId = null;

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((node) => {
    node.textContent = value;
  });
}

function createClaim(claim) {
  const article = document.createElement('article');
  article.className = 'evidence-claim';
  article.dataset.claimId = claim.id;

  const headingRow = document.createElement('div');
  headingRow.className = 'claim-heading-row';

  const headingGroup = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'claim-eyebrow';
  eyebrow.textContent = 'ממצא מבוסס ראיה';
  const heading = document.createElement('h3');
  heading.className = 'claim-title';
  heading.textContent = claim.title;
  headingGroup.append(eyebrow, heading);

  const factValue = document.createElement('span');
  factValue.className = 'claim-hero-value num';
  factValue.dir = 'auto';
  factValue.textContent = claim.factValue;
  headingRow.append(headingGroup, factValue);

  const text = document.createElement('p');
  text.className = 'claim-text';
  text.textContent = claim.text;

  const fact = document.createElement('dl');
  fact.className = 'fact-line';
  const term = document.createElement('dt');
  term.textContent = claim.factLabel;
  const valueWrap = document.createElement('dd');
  const value = document.createElement('span');
  value.className = 'num';
  value.dir = 'auto';
  value.textContent = claim.factValue;
  const unit = document.createElement('span');
  unit.className = 'fact-unit';
  unit.textContent = claim.factUnit;
  valueWrap.append(value, unit);
  fact.append(term, valueWrap);

  const source = FIXTURE.sources.find((item) => item.id === claim.sourceId);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-button';
  button.dataset.openSource = claim.sourceId;
  button.setAttribute('aria-pressed', 'false');
  button.textContent = `פתיחת מקור: ${source.label}`;

  article.append(headingRow, text, fact, button);
  return article;
}

function renderFixture() {
  panel.dataset.fixtureId = FIXTURE.id;
  setText('[data-fixture-question]', FIXTURE.question);
  setText('[data-fixture-summary]', FIXTURE.summary);
  setText('[data-fixture-as-of]', FIXTURE.asOf);
  setText('[data-fixture-scope]', FIXTURE.scope);

  document.querySelectorAll('[data-fixture-claims]').forEach((container) => {
    container.replaceChildren(...FIXTURE.claims.map(createClaim));
  });

  document.querySelectorAll('[data-fixture-tools]').forEach((list) => {
    const rows = FIXTURE.tools.map((tool) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = tool.label;
      const state = document.createElement('span');
      state.className = tool.state === 'חלקי' ? 'scope-state is-partial' : 'scope-state';
      state.textContent = tool.state;
      item.append(label, state);
      return item;
    });
    list.replaceChildren(...rows);
  });
}

function currentSource() {
  return FIXTURE.sources.find((source) => source.id === activeSourceId) ?? FIXTURE.sources[0];
}

function renderSource(source) {
  setText('[data-source-eyebrow]', source.eyebrow);
  setText('[data-source-title]', source.title);
  setText('[data-source-description]', source.description);
  setText('[data-source-route]', source.route);

  document.querySelectorAll('[data-source-rows]').forEach((list) => {
    const rows = source.rows.map(([labelText, valueText]) => {
      const row = document.createElement('div');
      row.className = 'source-record-row';
      const label = document.createElement('dt');
      label.textContent = labelText;
      const value = document.createElement('dd');
      value.className = 'num';
      value.dir = 'auto';
      value.textContent = valueText;
      row.append(label, value);
      return row;
    });
    list.replaceChildren(...rows);
  });
}

function announce(message) {
  if (!liveRegion) return;
  liveRegion.textContent = '';
  window.requestAnimationFrame(() => {
    liveRegion.textContent = message;
  });
}

function isDockedDesktop() {
  return root?.dataset.variant === 'docked' && desktopQuery.matches;
}

function showInternalSource(source) {
  if (!answerView || !sourceView) return;
  answerScrollTop = answerScroller?.scrollTop ?? 0;
  answerView.hidden = true;
  sourceView.hidden = false;
  panel.dataset.sourceOpen = 'true';
  renderSource(source);
  sourceHeading?.focus();
  announce(`נפתח מקור: ${source.title}`);
}

function showDockedSource(source, trigger) {
  renderSource(source);
  root.dataset.workspaceSourceOpen = 'true';
  document.querySelector('[data-workspace-default]')?.setAttribute('hidden', '');
  document.querySelector('[data-workspace-source]')?.removeAttribute('hidden');
  document.querySelectorAll('[data-open-source]').forEach((button) => {
    const active = button === trigger;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
  document.querySelector('[data-workspace-source-title]')?.focus();
  announce(`המקור ${source.title} פתוח לצד הבדיקה`);
}

function openSource(sourceId, trigger) {
  const source = FIXTURE.sources.find((item) => item.id === sourceId);
  if (!source) return;
  activeSourceId = source.id;
  returnFocus = trigger;
  if (isDockedDesktop()) showDockedSource(source, trigger);
  else showInternalSource(source);
}

function returnToAnswer() {
  if (isDockedDesktop()) {
    root.dataset.workspaceSourceOpen = 'false';
    document.querySelector('[data-workspace-source]')?.setAttribute('hidden', '');
    document.querySelector('[data-workspace-default]')?.removeAttribute('hidden');
  } else if (answerView && sourceView) {
    sourceView.hidden = true;
    answerView.hidden = false;
    panel.dataset.sourceOpen = 'false';
    if (answerScroller) answerScroller.scrollTop = answerScrollTop;
  }
  document.querySelectorAll('[data-open-source]').forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.removeAttribute('aria-current');
  });
  const target = returnFocus;
  activeSourceId = null;
  window.requestAnimationFrame(() => target?.focus());
  announce('חזרה לממצאי הבדיקה');
}

function modalMode() {
  return root?.dataset.variant === 'modal' || !desktopQuery.matches;
}

function updateMode() {
  if (!panel || !root) return;
  const modal = modalMode();
  root.dataset.mode = modal ? 'modal' : 'docked';
  if (modal) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'assistant-prototype-title');
  } else {
    panel.setAttribute('role', 'complementary');
    panel.removeAttribute('aria-modal');
    panel.setAttribute('aria-label', 'העוזר של InPlace — בדיקה תפעולית');
  }
  appShells.forEach((appShell) => {
    appShell.inert = panelOpen && modal;
    appShell.setAttribute('aria-hidden', panelOpen && modal ? 'true' : 'false');
  });
  if (!modal && activeSourceId && root.dataset.variant === 'docked') {
    const trigger = document.querySelector(`[data-open-source="${activeSourceId}"]`);
    showDockedSource(currentSource(), trigger);
  }
}

function setPanelOpen(open, trigger = null) {
  panelOpen = open;
  root.dataset.panelOpen = open ? 'true' : 'false';
  if (trigger) returnFocus = trigger;
  document.querySelectorAll('[data-panel-layer]').forEach((layer) => {
    layer.hidden = !open;
  });
  updateMode();
  if (open) {
    window.requestAnimationFrame(() => panel?.focus());
    announce('הבדיקה נפתחה');
  } else {
    returnToAnswer();
    appShells.forEach((appShell) => {
      appShell.inert = false;
      appShell.setAttribute('aria-hidden', 'false');
    });
    window.requestAnimationFrame(() => returnFocus?.focus());
  }
}

function focusableWithinPanel() {
  if (!panel) return [];
  return [...panel.querySelectorAll(
    'button:not([disabled]):not([hidden]), a[href]:not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])',
  )].filter((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  });
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const sourceTrigger = target.closest('[data-open-source]');
  if (sourceTrigger) {
    openSource(sourceTrigger.dataset.openSource, sourceTrigger);
    return;
  }
  const back = target.closest('[data-source-back], [data-workspace-back]');
  if (back) {
    returnToAnswer();
    return;
  }
  const openButton = target.closest('[data-open-assistant]');
  if (openButton) {
    setPanelOpen(true, openButton);
    return;
  }
  if (target.closest('[data-close-assistant]')) {
    setPanelOpen(false);
    return;
  }
  if (target.closest('[data-new-check]')) {
    answerScroller?.scrollTo({ top: answerScroller.scrollHeight, behavior: 'smooth' });
    window.setTimeout(() => document.querySelector('[data-new-question]')?.focus(), 180);
  }
});

document.addEventListener('keydown', (event) => {
  if (!panelOpen || !modalMode()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (activeSourceId) returnToAnswer();
    else setPanelOpen(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = focusableWithinPanel();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

document.querySelector('[data-prototype-form]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  announce('זהו prototype מבודד; לא נשלחה בדיקה');
});

desktopQuery.addEventListener('change', updateMode);
renderFixture();
renderSource(FIXTURE.sources[0]);
updateMode();

window.__assistantPrototype = Object.freeze({
  fixtureId: FIXTURE.id,
  fixtureQuestion: FIXTURE.question,
  fixtureSummary: FIXTURE.summary,
  variant: root?.dataset.variant,
  openSource: (sourceId) => openSource(sourceId, document.querySelector(`[data-open-source="${sourceId}"]`)),
  returnToAnswer,
});
