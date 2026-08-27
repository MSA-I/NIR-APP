const PRIORITY = new Map([
  ['needs-owner-decision', 0],
  ['decided-pending', 1],
  ['implementation-gap', 1],
  ['technical-debt', 2],
  ['decided-history', 3],
]);

export function summarizeCatalog(items, state) {
  return {
    needsDecision: items.filter((item) => item.status === 'needs-owner-decision').length,
    pendingImplementation: items.filter((item) => item.status === 'decided-pending' || item.status === 'implementation-gap').length,
    technicalDebt: items.filter((item) => item.status === 'technical-debt').length,
    history: items.filter((item) => item.status === 'decided-history').length,
    reconsiderations: state.reconsiderations.length,
  };
}
export function answerProgress(items, state) {
  const required = items.filter((item) => item.requiresOwnerDecision);
  const answered = required.filter((item) => Boolean(state.answers[item.key])).length;
  return { answered, total: required.length, complete: answered === required.length };
}

function matchesView(item, view) {
  if (view === 'all') return true;
  if (view === 'needs-decision') return item.status === 'needs-owner-decision';
  if (view === 'pending') return item.status === 'decided-pending' || item.status === 'implementation-gap';
  if (view === 'debt') return item.status === 'technical-debt';
  if (view === 'history') return item.status === 'decided-history';
  return true;
}

export function filterCatalogItems(items, { view = 'all', query = '' } = {}) {
  const normalized = query.trim().toLocaleLowerCase('he');
  return items
    .filter((item) => matchesView(item, view))
    .filter((item) => !normalized || `${item.plainQuestion} ${item.plainContext} ${item.section} ${item.key}`.toLocaleLowerCase('he').includes(normalized))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (PRIORITY.get(a.item.status) ?? 9) - (PRIORITY.get(b.item.status) ?? 9) || a.index - b.index)
    .map(({ item }) => item);
}
