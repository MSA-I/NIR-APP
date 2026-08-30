import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_NOTE_LENGTH = 2_000;
const MAX_REASON_LENGTH = 4_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function itemFor(catalog, key) {
  const item = catalog.items.find((candidate) => candidate.key === key);
  if (!item) fail('unknown_item');
  return item;
}

function assertRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) fail('revision_conflict');
}

function assertSource(item, sourceHash) {
  if (sourceHash !== item.sourceHash) fail('source_changed');
}

function cleanText(value, maxLength, required = false, minLength = 12) {
  if (value == null) {
    if (required) fail('text_required');
    return '';
  }
  if (typeof value !== 'string') fail('invalid_text');
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (required && cleaned.length < minLength) fail('text_required');
  if (cleaned.length > maxLength) fail('text_too_long');
  return cleaned;
}

export function createInitialState(catalog, now = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    sourceCommit: catalog.sourceCommit,
    sourceFiles: catalog.sourceFiles,
    status: 'in_progress',
    revision: 0,
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
    answers: {},
    staleAnswers: {},
    staleReconsiderations: [],
    debtPriorities: {},
    staleDebtPriorities: {},
    staleItems: [],
    reconsiderations: [],
  };
}

export function recordAnswer(state, catalog, payload, now = new Date().toISOString()) {
  assertRevision(state, payload.expectedRevision);
  const item = itemFor(catalog, payload.key);
  assertSource(item, payload.sourceHash);
  if (!item.requiresOwnerDecision) fail('reconsideration_required');
  const allowed = new Set([...item.options.map((option) => option.id), 'not_sure', 'needs_explanation']);
  if (!allowed.has(payload.selection)) fail('invalid_selection');
  const note = cleanText(payload.note, MAX_NOTE_LENGTH);
  const staleAnswers = { ...(state.staleAnswers || {}) };
  delete staleAnswers[item.key];
  return {
    ...state,
    status: 'in_progress',
    revision: state.revision + 1,
    updatedAt: now,
    finalizedAt: null,
    answers: {
      ...state.answers,
      [item.key]: {
        key: item.key,
        sourceHash: item.sourceHash,
        selection: payload.selection,
        note,
        confirmedAt: now,
        version: (state.answers[item.key]?.version || 0) + 1,
      },
    },
    staleAnswers,
    staleItems: (state.staleItems || []).filter((key) => key !== item.key),
  };
}

export function recordReconsideration(state, catalog, payload, now = new Date().toISOString()) {
  assertRevision(state, payload.expectedRevision);
  const item = itemFor(catalog, payload.key);
  assertSource(item, payload.sourceHash);
  if (item.requiresOwnerDecision) fail('direct_answer_required');
  const requestedChoice = cleanText(payload.requestedChoice, MAX_NOTE_LENGTH, true, 2);
  const reason = cleanText(payload.reason, MAX_REASON_LENGTH, true);
  const staleReconsiderations = (state.staleReconsiderations || []).map((request) => (
    request.key === item.key && !request.supersededAt ? { ...request, supersededAt: now } : request
  ));
  const staleAnswerStillOpen = Boolean(state.staleAnswers?.[item.key]);
  return {
    ...state,
    status: 'in_progress',
    revision: state.revision + 1,
    updatedAt: now,
    finalizedAt: null,
    reconsiderations: [
      ...state.reconsiderations,
      {
        id: randomUUID(),
        key: item.key,
        sourceHash: item.sourceHash,
        previousDecision: item.currentDecisionPlain,
        requestedChoice,
        reason,
        requestedAt: now,
      },
    ],
    staleReconsiderations,
    staleItems: staleAnswerStillOpen ? state.staleItems : (state.staleItems || []).filter((key) => key !== item.key),
  };
}

export function recordDebtPriority(state, catalog, payload, now = new Date().toISOString()) {
  assertRevision(state, payload.expectedRevision);
  const item = itemFor(catalog, payload.key);
  assertSource(item, payload.sourceHash);
  if (item.type !== 'debt' || item.requiresOwnerDecision) fail('technical_debt_required');
  if (!['plan_now', 'keep_backlog', 'needs_explanation', 'follow_recommendation'].includes(payload.priority)) fail('invalid_priority');
  const staleDebtPriorities = { ...(state.staleDebtPriorities || {}) };
  delete staleDebtPriorities[item.key];
  const otherStale = Boolean(state.staleAnswers?.[item.key])
    || (state.staleReconsiderations || []).some((request) => request.key === item.key && !request.supersededAt);
  return {
    ...state,
    status: 'in_progress',
    revision: state.revision + 1,
    updatedAt: now,
    finalizedAt: null,
    debtPriorities: {
      ...(state.debtPriorities || {}),
      [item.key]: {
        key: item.key,
        sourceHash: item.sourceHash,
        priority: payload.priority,
        resolvedPriority: payload.priority === 'follow_recommendation' ? item.recommendedPriority : payload.priority,
        selectedAt: now,
        version: (state.debtPriorities?.[item.key]?.version || 0) + 1,
      },
    },
    staleDebtPriorities,
    staleItems: otherStale ? state.staleItems : (state.staleItems || []).filter((key) => key !== item.key),
  };
}

export function finalizeState(state, catalog, payload, now = new Date().toISOString()) {
  assertRevision(state, payload.expectedRevision);
  if (payload.sourceCommit !== catalog.sourceCommit) fail('source_changed');
  if (state.staleItems?.length) fail('source_changed');
  const missing = catalog.items
    .filter((item) => item.requiresOwnerDecision && !state.answers[item.key])
    .map((item) => item.key);
  if (missing.length) {
    const error = new Error('answers_missing');
    error.code = 'answers_missing';
    error.missing = missing;
    throw error;
  }
  return { ...state, status: 'ready_for_planning', revision: state.revision + 1, updatedAt: now, finalizedAt: now };
}

export function reconcileSavedState(saved, catalog, now = new Date().toISOString()) {
  const itemMap = new Map(catalog.items.map((item) => [item.key, item]));
  const answers = {};
  const staleAnswers = { ...(saved.staleAnswers || {}) };
  for (const [key, answer] of Object.entries(saved.answers || {})) {
    const item = itemMap.get(key);
    if (item && item.sourceHash === answer.sourceHash) answers[key] = answer;
    else staleAnswers[key] = answer;
  }
  for (const key of Object.keys(staleAnswers)) {
    if (answers[key]) delete staleAnswers[key];
  }
  const reconsiderations = [];
  const staleReconsiderations = [...(saved.staleReconsiderations || [])];
  for (const request of saved.reconsiderations || []) {
    const item = itemMap.get(request.key);
    if (item && item.sourceHash === request.sourceHash) reconsiderations.push(request);
    else staleReconsiderations.push({ ...request, staleDetectedAt: request.staleDetectedAt || now, supersededAt: request.supersededAt || null });
  }
  const staleItems = [...new Set([
    ...Object.keys(staleAnswers).filter((key) => itemMap.has(key)),
    ...staleReconsiderations.filter((request) => !request.supersededAt && itemMap.has(request.key)).map((request) => request.key),
  ])].sort();
  const debtPriorities = {};
  const staleDebtPriorities = { ...(saved.staleDebtPriorities || {}) };
  for (const [key, priority] of Object.entries(saved.debtPriorities || {})) {
    const item = itemMap.get(key);
    if (item && item.sourceHash === priority.sourceHash) debtPriorities[key] = priority;
    else staleDebtPriorities[key] = priority;
  }
  for (const key of Object.keys(staleDebtPriorities)) {
    if (debtPriorities[key]) delete staleDebtPriorities[key];
  }
  const allStaleItems = [...new Set([
    ...staleItems,
    ...Object.keys(staleDebtPriorities).filter((key) => itemMap.has(key)),
  ])].sort();
  const changed = saved.sourceCommit !== catalog.sourceCommit
    || saved.sourceFiles?.decisions !== catalog.sourceFiles?.decisions
    || saved.sourceFiles?.debts !== catalog.sourceFiles?.debts
    || allStaleItems.join('|') !== (saved.staleItems || []).join('|')
    || reconsiderations.length !== (saved.reconsiderations || []).length
    || Object.keys(debtPriorities).length !== Object.keys(saved.debtPriorities || {}).length;
  return {
    ...saved,
    sourceCommit: catalog.sourceCommit,
    sourceFiles: catalog.sourceFiles,
    status: allStaleItems.length && saved.status === 'ready_for_planning' ? 'in_progress' : saved.status,
    revision: changed ? saved.revision + 1 : saved.revision,
    updatedAt: changed ? now : saved.updatedAt,
    finalizedAt: allStaleItems.length ? null : saved.finalizedAt,
    answers,
    staleAnswers,
    reconsiderations,
    staleReconsiderations,
    debtPriorities,
    staleDebtPriorities,
    staleItems: allStaleItems,
  };
}

function markdownFor(state, catalog) {
  const itemMap = new Map(catalog.items.map((item) => [item.key, item]));
  const lines = [
    '# InPlace — תוצאות מסמך ההחלטות',
    '',
    `- מצב: **${state.status}**`,
    `- גרסת מקור: \`${state.sourceCommit}\``,
    `- עדכון אחרון: ${state.updatedAt}`,
    `- גרסת שמירה: ${state.revision}`,
    '',
    '## תשובות',
    '',
  ];
  const answers = Object.values(state.answers);
  if (!answers.length) lines.push('טרם נשמרו תשובות.');
  for (const answer of answers) {
    const item = itemMap.get(answer.key);
    const option = item?.options.find((candidate) => candidate.id === answer.selection);
    const label = option?.label || (answer.selection === 'not_sure' ? 'לא בטוח' : 'צריך הסבר נוסף');
    lines.push(`### ${answer.key} — ${item?.plainQuestion || answer.key}`, '', `- בחירה: **${label}**`, `- זמן: ${answer.confirmedAt}`);
    if (answer.note) lines.push(`- הערה: ${answer.note}`);
    lines.push('');
  }
  lines.push('## בקשות שינוי', '');
  if (!state.reconsiderations.length) lines.push('לא נפתחו בקשות שינוי.');
  for (const request of state.reconsiderations) {
    const item = itemMap.get(request.key);
    lines.push(`### ${request.key} — ${item?.plainQuestion || request.key}`, '', `- ההחלטה הקודמת: ${request.previousDecision}`, `- השינוי המבוקש: ${request.requestedChoice}`, `- סיבה: ${request.reason}`, `- זמן: ${request.requestedAt}`, '');
  }
  lines.push('## עדיפות לחובות טכניים', '');
  const debtPriorities = Object.values(state.debtPriorities || {});
  if (!debtPriorities.length) lines.push('טרם סומנו חובות לקידום.');
  for (const priority of debtPriorities) {
    const item = itemMap.get(priority.key);
    const labels = { plan_now: 'לקדם בתוכנית הקרובה', keep_backlog: 'להשאיר בתור', needs_explanation: 'נדרש הסבר נוסף', follow_recommendation: 'לפעול לפי המלצת הסוכן' };
    const resolved = priority.priority === 'follow_recommendation' ? ` — בפועל: ${labels[priority.resolvedPriority]}` : '';
    lines.push(`- **${priority.key} — ${item?.plainQuestion || priority.key}:** ${labels[priority.priority]}${resolved} (${priority.selectedAt})`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function saveStateAtomic(directory, state, catalog, { renameFile = rename, removeFile = rm } = {}) {
  await mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, 'current.json');
  const markdownPath = path.join(directory, 'current.md');
  const suffix = `${process.pid}-${randomUUID()}`;
  const jsonTemp = `${jsonPath}.${suffix}.tmp`;
  const markdownTemp = `${markdownPath}.${suffix}.tmp`;
  const warnings = [];
  try {
    await Promise.all([
      writeFile(jsonTemp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
      writeFile(markdownTemp, markdownFor(state, catalog), { encoding: 'utf8', flag: 'wx' }),
    ]);
    await renameFile(jsonTemp, jsonPath);
    try {
      await renameFile(markdownTemp, markdownPath);
    } catch {
      warnings.push('markdown_not_updated');
      await removeFile(markdownTemp, { force: true });
    }
  } catch (error) {
    await Promise.allSettled([
      removeFile(jsonTemp, { force: true }),
      removeFile(markdownTemp, { force: true }),
    ]);
    throw error;
  }
  return { warnings };
}

export async function loadState(directory, catalog) {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, 'current.json'), 'utf8'));
    if (parsed.schemaVersion !== 1 || typeof parsed.revision !== 'number') fail('saved_state_invalid');
    return reconcileSavedState(parsed, catalog);
  } catch (error) {
    if (error?.code === 'ENOENT') return createInitialState(catalog);
    throw error;
  }
}
