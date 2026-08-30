import { answerProgress, filterCatalogItems, summarizeCatalog } from './ui-model.mjs';

const VIEW_LABELS = [
  ['all', 'הכול'],
  ['needs-decision', 'דורש החלטה'],
  ['pending', 'הוחלט, טרם הושלם'],
  ['debt', 'חוב טכני'],
  ['history', 'החלטות עבר'],
];

const STATUS_LABELS = {
  'needs-owner-decision': ['דורש החלטה ממך', 'attention'],
  'decided-pending': ['הוחלט, טרם הושלם', ''],
  'implementation-gap': ['נותרה עבודת מימוש', ''],
  'technical-debt': ['חוב פעיל — מידע', ''],
  'decided-history': ['החלטה קיימת', 'done'],
};

const IMPACT_LABELS = {
  customer: 'לקוחות',
  money: 'כסף ועלות',
  privacy: 'פרטיות',
  security: 'אבטחה',
  effort: 'עבודת פיתוח',
};

const elements = {
  summary: document.querySelector('#summary'),
  tabs: document.querySelector('#view-tabs'),
  search: document.querySelector('#search'),
  list: document.querySelector('#decision-list'),
  resultCount: document.querySelector('#result-count'),
  loadMore: document.querySelector('#load-more'),
  finalize: document.querySelector('#finalize'),
  progressLabel: document.querySelector('#progress-label'),
  progressFill: document.querySelector('#progress-fill'),
  saveIndicator: document.querySelector('#save-indicator'),
  sourceCommit: document.querySelector('#source-commit'),
  sourceStatus: document.querySelector('#source-status'),
  globalMessage: document.querySelector('#global-message'),
  live: document.querySelector('#live-region'),
};

let catalog;
let state;
let currentView = 'all';
let currentQuery = '';
let visibleCount = 24;
const openReconsiderations = new Set();
const staleKeys = new Set();
const pendingSelections = new Map();
const pendingDebtPriorities = new Map();
let mutationQueue = Promise.resolve();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || 'request_failed');
    error.code = value.error;
    error.missing = value.missing;
    throw error;
  }
  return value;
}

function setSaveStatus(kind, message) {
  elements.saveIndicator.className = `save-indicator ${kind ? `is-${kind}` : ''}`;
  elements.saveIndicator.textContent = message;
}

function showMessage(message) {
  elements.globalMessage.hidden = !message;
  elements.globalMessage.textContent = message || '';
  if (message) elements.globalMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function statusMarkup(item) {
  const [label, tone] = STATUS_LABELS[item.status] || ['פריט מתועד', ''];
  return `<span class="status-badge ${tone}">${escapeHtml(label)}</span>`;
}

function impactMarkup(item) {
  return `<section class="impact-section" aria-label="השפעות ההחלטה">
    <h4>איך זה עשוי להשפיע</h4>
    <div class="impact-grid">${Object.entries(IMPACT_LABELS).map(([key, label]) => `<article class="impact-item"><strong>${label}</strong><p>${escapeHtml(item.impactAreas[key])}</p></article>`).join('')}</div>
  </section>`;
}

function optionsMarkup(item, answer) {
  const selection = pendingSelections.get(item.key) || answer?.selection;
  const options = item.options.map((option) => `<label class="option">
    <input type="radio" name="choice-${escapeHtml(item.key)}" value="${escapeHtml(option.id)}" data-answer-key="${escapeHtml(item.key)}" ${selection === option.id ? 'checked' : ''}>
    <span class="option-copy"><strong>${escapeHtml(option.label)}</strong>${item.recommendation === option.id ? '<span class="recommended">המלצה</span>' : ''}<small>${escapeHtml(option.implication)}</small></span>
  </label>`).join('');
  return `<fieldset class="options"><legend>בחר את האפשרות המתאימה</legend>${options}
    <div class="uncertainty-options">
      <label class="uncertainty-option"><input type="radio" name="choice-${escapeHtml(item.key)}" value="not_sure" data-answer-key="${escapeHtml(item.key)}" ${selection === 'not_sure' ? 'checked' : ''}>לא בטוח עדיין</label>
      <label class="uncertainty-option"><input type="radio" name="choice-${escapeHtml(item.key)}" value="needs_explanation" data-answer-key="${escapeHtml(item.key)}" ${selection === 'needs_explanation' ? 'checked' : ''}>צריך הסבר נוסף</label>
    </div>
  </fieldset>`;
}

function glossaryMarkup(item) {
  if (!item.glossary.length) return '';
  return `<div class="glossary" aria-label="מילון מונחים">${item.glossary.map((entry) => `<span title="${escapeHtml(entry.explanation)}">${escapeHtml(entry.term)} — ${escapeHtml(entry.explanation)}</span>`).join('')}</div>`;
}

function debtActionMarkup(item) {
  if (item.type !== 'debt' || item.closed) return '';
  const savedPriority = state.debtPriorities?.[item.key]?.priority;
  const priority = pendingDebtPriorities.get(item.key) || savedPriority;
  const recommendationLabel = item.recommendedPriority === 'plan_now' ? 'לקדם בתוכנית הקרובה' : 'להשאיר בתור כרגע';
  const recommendation = item.requiresOwnerDecision ? '' : `<div class="debt-recommendation"><strong>ההמלצה שלי: ${recommendationLabel}</strong><p>${escapeHtml(item.recommendationReason)}</p></div>`;
  const priorityOptions = item.requiresOwnerDecision ? '' : `<fieldset class="debt-priority-options">
    <legend>מה אתה רוצה לעשות עם החוב?</legend>
    <label class="recommended-priority"><input type="radio" name="debt-priority-${escapeHtml(item.key)}" value="follow_recommendation" data-debt-priority-key="${escapeHtml(item.key)}" ${priority === 'follow_recommendation' ? 'checked' : ''}>לפעול לפי ההמלצה — ${recommendationLabel}</label>
    <label><input type="radio" name="debt-priority-${escapeHtml(item.key)}" value="plan_now" data-debt-priority-key="${escapeHtml(item.key)}" ${priority === 'plan_now' ? 'checked' : ''}>לקדם לתוכנית הקרובה</label>
    <label><input type="radio" name="debt-priority-${escapeHtml(item.key)}" value="keep_backlog" data-debt-priority-key="${escapeHtml(item.key)}" ${priority === 'keep_backlog' ? 'checked' : ''}>להשאיר בתור</label>
    <label><input type="radio" name="debt-priority-${escapeHtml(item.key)}" value="needs_explanation" data-debt-priority-key="${escapeHtml(item.key)}" ${priority === 'needs_explanation' ? 'checked' : ''}>צריך הסבר נוסף</label>
  </fieldset>`;
  return `<section class="debt-action" aria-label="המשך טיפול בחוב">
    <div class="debt-next-step"><h4>מה עושים עכשיו</h4><p>${escapeHtml(item.nextAction)}</p></div>
    ${recommendation}
    <dl class="debt-meta">
      <div><dt>מי מטפל</dt><dd>${escapeHtml(item.responsibility)}</dd></div>
      <div><dt>מה נדרש ממך</dt><dd>${escapeHtml(item.ownerInstruction)}</dd></div>
      <div><dt>מתי נחשב סגור</dt><dd>${escapeHtml(item.completionProof)}</dd></div>
    </dl>
    ${priorityOptions}
  </section>`;
}

function reconsiderationMarkup(item) {
  if (!openReconsiderations.has(item.key)) return '';
  return `<form class="reconsider-form" data-reconsider-form="${escapeHtml(item.key)}">
    <strong>בקשת שינוי חדשה</strong>
    <label>מה תרצה שיקרה במקום?<textarea name="requestedChoice" required minlength="2" maxlength="2000"></textarea></label>
    <label>למה המצב השתנה?<textarea name="reason" required minlength="12" maxlength="4000"></textarea></label>
    <button type="submit">שמור בקשת שינוי</button>
  </form>`;
}

function cardMarkup(item) {
  const answer = state.answers[item.key];
  const stale = staleKeys.has(item.key);
  const existingRequests = state.reconsiderations.filter((request) => request.key === item.key).length;
  return `<article class="decision-card ${escapeHtml(item.status)} ${stale ? 'source-stale' : ''}" data-card-key="${escapeHtml(item.key)}">
    <div class="card-topline">${statusMarkup(item)}<span class="card-id">${escapeHtml(item.key)}</span></div>
    <h3>${escapeHtml(item.plainQuestion)}</h3>
    <p class="plain-context">${escapeHtml(item.plainContext)}</p>
    ${item.type === 'decision' ? `<p class="current-decision"><strong>הבחירה המתועדת כיום:</strong> ${escapeHtml(item.currentDecisionPlain)}</p>` : ''}
    <div class="why-box"><span class="why-mark" aria-hidden="true">?</span><p><strong>למה זה חשוב:</strong> ${escapeHtml(item.whyItMatters)}</p></div>
    ${stale ? '<p class="stale-warning">מסמך המקור השתנה מאז הבחירה הקודמת. קרא את הנוסח המעודכן ובחר שוב; הבחירה הישנה נשמרה בנפרד.</p>' : ''}
    ${item.requiresOwnerDecision ? optionsMarkup(item, answer) : ''}
    ${debtActionMarkup(item)}
    ${impactMarkup(item)}
    <p class="boundary-note"><strong>מה לא יקרה אוטומטית:</strong> ${escapeHtml(item.whatItDoesNotDo)}</p>
    <div class="card-actions">
      ${item.changeMode === 'reconsideration-only' ? `<button type="button" class="reconsider-button" data-reconsider="${escapeHtml(item.key)}">אני רוצה לשנות החלטה זו${existingRequests ? ` · ${existingRequests} בקשות קיימות` : ''}</button>` : ''}
      ${item.changeMode === 'information-only' ? '<span class="status-badge">אין החלטה נדרשת ממך</span>' : ''}
    </div>
    ${reconsiderationMarkup(item)}
    ${glossaryMarkup(item)}
    <details class="technical-details"><summary>הצג פרטי מקור טכניים</summary><pre>${escapeHtml(item.sourceDetails)}</pre></details>
  </article>`;
}

function renderSummary() {
  const summary = summarizeCatalog(catalog.items, state);
  const cards = [
    ['needsDecision', 'דורש החלטה ממך', true],
    ['pendingImplementation', 'הוחלט, טרם הושלם', false],
    ['technicalDebt', 'חובות טכניים', false],
    ['history', 'החלטות עבר', false],
    ['reconsiderations', 'בקשות שינוי', false],
  ];
  elements.summary.innerHTML = cards.map(([key, label, primary]) => `<article class="summary-card ${primary ? 'is-primary' : ''}"><strong>${summary[key]}</strong><span>${label}</span></article>`).join('');
}

function renderTabs() {
  elements.tabs.innerHTML = VIEW_LABELS.map(([id, label]) => `<button type="button" class="view-tab" data-view="${id}" aria-current="${currentView === id}">${label}</button>`).join('');
}

function renderList() {
  const filtered = filterCatalogItems(catalog.items, { view: currentView, query: currentQuery });
  const visible = filtered.slice(0, visibleCount);
  elements.resultCount.textContent = `${filtered.length} פריטים`;
  elements.list.innerHTML = visible.length ? visible.map(cardMarkup).join('') : '<article class="decision-card"><h3>לא נמצאו פריטים</h3><p class="plain-context">נסה ניסוח אחר או הסר את הסינון.</p></article>';
  elements.list.setAttribute('aria-busy', 'false');
  elements.loadMore.hidden = visible.length >= filtered.length;
  elements.loadMore.textContent = `הצג עוד (${filtered.length - visible.length})`;
}

function renderProgress() {
  const progress = answerProgress(catalog.items, state);
  const percentage = progress.total ? Math.round((progress.answered / progress.total) * 100) : 100;
  elements.progressLabel.textContent = state.status === 'ready_for_planning' ? 'הבחירות מוכנות לקריאת הסוכן' : `${progress.answered} מתוך ${progress.total} שאלות נענו`;
  elements.progressFill.style.transform = `scaleX(${percentage / 100})`;
  elements.finalize.disabled = !progress.complete || staleKeys.size > 0 || state.status === 'ready_for_planning';
  elements.finalize.textContent = state.status === 'ready_for_planning' ? 'מוכן לתכנון' : 'סיימתי — מוכן לתכנון';
}

function renderAll() {
  renderSummary();
  renderTabs();
  renderList();
  renderProgress();
}

function errorMessage(error) {
  const messages = {
    source_changed: 'מסמך המקור השתנה. הבחירה לא נשמרה; יש להפעיל מחדש את הכלי כדי לרענן.',
    revision_conflict: 'נשמר שינוי אחר במקביל. מצב השמירה נטען מחדש והבחירה תישלח שוב בלי לדרוס מידע.',
    reconsideration_required: 'החלטה קיימת אינה נדרסת. יש לפתוח בקשת שינוי.',
    answers_missing: 'יש להשיב לכל השאלות, גם אם התשובה היא “לא בטוח” או “צריך הסבר נוסף”.',
  };
  return messages[error.code] || 'השמירה נכשלה. שום החלטה קיימת לא שונתה.';
}

function enqueueMutation(operation) {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.catch(() => {});
  return next;
}

async function postMutation(path, payload) {
  try {
    return await api(path, { method: 'POST', body: JSON.stringify({ ...payload, expectedRevision: state.revision }) });
  } catch (error) {
    if (error.code !== 'revision_conflict') throw error;
    state = await api('/api/state');
    return api(path, { method: 'POST', body: JSON.stringify({ ...payload, expectedRevision: state.revision }) });
  }
}

function saveAnswer(key, selection) {
  const item = catalog.items.find((candidate) => candidate.key === key);
  if (!item) return;
  pendingSelections.set(key, selection);
  setSaveStatus('saving', 'שומר בחירה…');
  showMessage('');
  void enqueueMutation(async () => {
    if (pendingSelections.get(key) !== selection) return;
    try {
      state = await postMutation('/api/answer', { key, selection, sourceHash: item.sourceHash, note: state.answers[key]?.note || '' });
      if (pendingSelections.get(key) === selection) pendingSelections.delete(key);
      staleKeys.delete(key);
      setSaveStatus(pendingSelections.size ? 'saving' : 'saved', pendingSelections.size ? 'שומר בחירות…' : 'נשמר אוטומטית');
      elements.live.textContent = `הבחירה עבור ${item.plainQuestion} נשמרה`;
      renderProgress();
    } catch (error) {
      if (pendingSelections.get(key) === selection) pendingSelections.delete(key);
      if (error.code === 'source_changed') staleKeys.add(key);
      setSaveStatus('error', 'לא נשמר');
      showMessage(errorMessage(error));
      renderList();
      renderProgress();
    }
  });
}

function saveDebtPriority(key, priority) {
  const item = catalog.items.find((candidate) => candidate.key === key);
  if (!item) return;
  pendingDebtPriorities.set(key, priority);
  setSaveStatus('saving', 'שומר עדיפות…');
  showMessage('');
  void enqueueMutation(async () => {
    if (pendingDebtPriorities.get(key) !== priority) return;
    try {
      state = await postMutation('/api/debt-priority', { key, priority, sourceHash: item.sourceHash });
      if (pendingDebtPriorities.get(key) === priority) pendingDebtPriorities.delete(key);
      staleKeys.delete(key);
      setSaveStatus(pendingDebtPriorities.size || pendingSelections.size ? 'saving' : 'saved', pendingDebtPriorities.size || pendingSelections.size ? 'שומר בחירות…' : 'נשמר אוטומטית');
      elements.live.textContent = `העדיפות עבור ${item.plainQuestion} נשמרה`;
    } catch (error) {
      if (pendingDebtPriorities.get(key) === priority) pendingDebtPriorities.delete(key);
      if (error.code === 'source_changed') staleKeys.add(key);
      setSaveStatus('error', 'לא נשמר');
      showMessage(errorMessage(error));
      renderList();
      renderProgress();
    }
  });
}

async function saveReconsideration(form, key) {
  const item = catalog.items.find((candidate) => candidate.key === key);
  const data = new FormData(form);
  setSaveStatus('saving', 'שומר בקשת שינוי…');
  return enqueueMutation(async () => {
    try {
      state = await postMutation('/api/reconsideration', {
        key,
        sourceHash: item.sourceHash,
        requestedChoice: data.get('requestedChoice'),
        reason: data.get('reason'),
      });
      staleKeys.delete(key);
      openReconsiderations.delete(key);
      setSaveStatus('saved', 'בקשת השינוי נשמרה');
      elements.live.textContent = `בקשת השינוי עבור ${item.plainQuestion} נשמרה`;
      renderAll();
    } catch (error) {
      setSaveStatus('error', 'לא נשמר');
      showMessage(errorMessage(error));
    }
  });
}

elements.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  currentView = button.dataset.view;
  visibleCount = 24;
  renderTabs();
  renderList();
});

elements.search.addEventListener('input', () => {
  currentQuery = elements.search.value;
  visibleCount = 24;
  renderList();
});

elements.loadMore.addEventListener('click', () => {
  visibleCount += 24;
  renderList();
});

elements.list.addEventListener('change', (event) => {
  const input = event.target.closest('[data-answer-key]');
  if (input) void saveAnswer(input.dataset.answerKey, input.value);
  const debtPriority = event.target.closest('[data-debt-priority-key]');
  if (debtPriority) saveDebtPriority(debtPriority.dataset.debtPriorityKey, debtPriority.value);
});

elements.list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-reconsider]');
  if (!button) return;
  const key = button.dataset.reconsider;
  if (openReconsiderations.has(key)) openReconsiderations.delete(key);
  else openReconsiderations.add(key);
  renderList();
  document.querySelector(`[data-reconsider-form="${CSS.escape(key)}"] textarea`)?.focus();
});

elements.list.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-reconsider-form]');
  if (!form) return;
  event.preventDefault();
  void saveReconsideration(form, form.dataset.reconsiderForm);
});

elements.finalize.addEventListener('click', () => {
  setSaveStatus('saving', 'מסמן כמוכן לתכנון…');
  void enqueueMutation(async () => {
    try {
      state = await postMutation('/api/finalize', { sourceCommit: catalog.sourceCommit });
      setSaveStatus('saved', 'מוכן לקריאת הסוכן');
      elements.live.textContent = 'הבחירות סומנו כמוכנות לתכנון';
      renderProgress();
    } catch (error) {
      setSaveStatus('error', 'לא הושלם');
      showMessage(errorMessage(error));
    }
  });
});

async function start() {
  try {
    [catalog, state] = await Promise.all([api('/api/catalog'), api('/api/state')]);
    for (const key of state.staleItems || []) staleKeys.add(key);
    elements.sourceCommit.textContent = catalog.sourceCommit.slice(0, 12);
    elements.sourceStatus.textContent = `${catalog.counts.decisions} הכרעות · ${catalog.counts.debts} חובות`;
    setSaveStatus('saved', state.revision ? 'השמירה שוחזרה' : 'מוכן לשמירה');
    renderAll();
  } catch (error) {
    setSaveStatus('error', 'הטעינה נכשלה');
    showMessage('לא ניתן לטעון את מסמך ההחלטות. בדוק שהחלון השחור של הכלי עדיין פתוח.');
  }
}

void start();
