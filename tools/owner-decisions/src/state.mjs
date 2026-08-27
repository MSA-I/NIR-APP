import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  const staleItems = Object.keys(staleAnswers).filter((key) => itemMap.get(key)?.requiresOwnerDecision).sort();
  const changed = saved.sourceCommit !== catalog.sourceCommit
    || saved.sourceFiles?.decisions !== catalog.sourceFiles?.decisions
    || saved.sourceFiles?.debts !== catalog.sourceFiles?.debts
    || staleItems.join('|') !== (saved.staleItems || []).join('|');
  return {
    ...saved,
    sourceCommit: catalog.sourceCommit,
    sourceFiles: catalog.sourceFiles,
    status: staleItems.length && saved.status === 'ready_for_planning' ? 'in_progress' : saved.status,
    revision: changed ? saved.revision + 1 : saved.revision,
    updatedAt: changed ? now : saved.updatedAt,
    finalizedAt: staleItems.length ? null : saved.finalizedAt,
    answers,
    staleAnswers,
    staleItems,
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
  return `${lines.join('\n')}\n`;
}

export async function saveStateAtomic(directory, state, catalog) {
  await mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, 'current.json');
  const markdownPath = path.join(directory, 'current.md');
  const suffix = `${process.pid}-${randomUUID()}`;
  const jsonTemp = `${jsonPath}.${suffix}.tmp`;
  const markdownTemp = `${markdownPath}.${suffix}.tmp`;
  await Promise.all([
    writeFile(jsonTemp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
    writeFile(markdownTemp, markdownFor(state, catalog), { encoding: 'utf8', flag: 'wx' }),
  ]);
  await rename(jsonTemp, jsonPath);
  await rename(markdownTemp, markdownPath);
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
