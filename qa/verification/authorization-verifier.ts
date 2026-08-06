import { createVerificationResult, type VerificationCheck, type VerificationResult } from './types.ts';

export interface AuthorizationObservation {
  id: string;
  role: string;
  route: string;
  operation: string;
  expected: 'ALLOW' | 'DENY';
  requestAttempted: boolean;
  responseStatus?: number;
  renderedAuthorizedContent: boolean;
  redirectedTo?: string;
  databaseChanged: boolean;
  auditChanged: boolean;
}

function verifyObservation(observation: AuthorizationObservation): VerificationCheck {
  const route = new URL(observation.route, 'http://127.0.0.1').pathname;
  const deniedByHttp = observation.responseStatus === 401 || observation.responseStatus === 403;
  const deniedByRoute = Boolean(observation.redirectedTo)
    && new URL(observation.redirectedTo ?? '/', 'http://127.0.0.1').pathname !== route;
  let passed: boolean;
  let rationale: string;

  if (observation.expected === 'DENY') {
    const noMutation = !observation.databaseChanged && !observation.auditChanged;
    const accessDenied = observation.requestAttempted && deniedByHttp;
    passed = accessDenied && noMutation && !observation.renderedAuthorizedContent;
    rationale = passed
      ? 'The actor request was denied by the server, exposed no authorized content, and produced no data/audit mutation.'
      : 'Expected denial lacked an actor HTTP 401/403, leaked content, or changed data; a UI redirect alone is insufficient.';
  } else {
    const successfulHttp = observation.responseStatus === undefined
      || (observation.responseStatus >= 200 && observation.responseStatus < 300);
    passed = observation.renderedAuthorizedContent && successfulHttp && !deniedByRoute && !deniedByHttp;
    rationale = passed
      ? 'Allowed route/operation rendered authorized content without a denial signal.'
      : 'Expected allowed access was denied or never rendered authorized content.';
  }

  return {
    id: observation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: rationale,
    evidence: {
      role: observation.role,
      route,
      operation: observation.operation,
      expected: observation.expected,
      requestAttempted: observation.requestAttempted,
      responseStatus: observation.responseStatus,
      renderedAuthorizedContent: observation.renderedAuthorizedContent,
      redirectedPath: observation.redirectedTo
        ? new URL(observation.redirectedTo, 'http://127.0.0.1').pathname
        : undefined,
      databaseChanged: observation.databaseChanged,
      auditChanged: observation.auditChanged,
    },
  };
}

export function verifyAuthorizationObservations(
  observations: readonly AuthorizationObservation[],
): VerificationResult {
  if (observations.length === 0) {
    return createVerificationResult('authorization', 'No authorization observations were supplied.', [{
      id: 'authorization-evidence-missing',
      status: 'BLOCKED',
      summary: 'Authorization cannot PASS without captured browser/API and post-action database evidence.',
    }]);
  }
  const checks = observations.map(verifyObservation);
  return createVerificationResult(
    'authorization',
    'Authorization outcomes were evaluated from captured actor actions plus post-action evidence; this verifier did not act for the user.',
    checks,
    { observationCount: observations.length, mutationMethodsExposed: false },
  );
}
