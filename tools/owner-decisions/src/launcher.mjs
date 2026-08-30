export function matchesExistingServer(health, expected) {
  return health?.ok === true
    && health.sourceCommit === expected.sourceCommit
    && health.instanceId === expected.instanceId
    && health.sourceFiles?.decisions === expected.sourceFiles?.decisions
    && health.sourceFiles?.debts === expected.sourceFiles?.debts;
}
