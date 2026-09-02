const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) throw new Error(`missing source contract: ${expected}`);
}

Deno.test("fresh password signup requests confirmation before its neutral answer", () => {
  const passwordBranch = source.slice(source.indexOf("const outcome = await provisionTenant"));
  const sendPattern = /sendSignupConfirmation\(\s*admin,\s*input\.ownerEmail\.trim\(\)\.toLowerCase\(\),?\s*\)/g;
  if (!sendPattern.test(passwordBranch)) {
    throw new Error("the password branch does not ask Auth to confirm its normalized address");
  }
  const sendPosition = passwordBranch.indexOf("sendSignupConfirmation(");
  const answerPosition = passwordBranch.lastIndexOf("status: 'pending_confirmation'");
  if (sendPosition < 0 || answerPosition < 0 || sendPosition > answerPosition) {
    throw new Error("the neutral answer can return before Auth accepts the confirmation request");
  }

  const sends = passwordBranch.match(sendPattern) ?? [];
  if (sends.length !== 1) {
    throw new Error(`the fresh signup has ${sends.length} confirmation-send paths`);
  }
});

Deno.test("duplicate addresses keep the neutral response without exposing confirmation state", () => {
  const passwordBranch = source.slice(source.indexOf("const outcome = await provisionTenant"));
  const duplicateStart = passwordBranch.indexOf("outcome.failure.kind === 'email_taken'");
  const duplicateEnd = passwordBranch.indexOf("code: 'signup_failed'", duplicateStart);
  const duplicateBranch = passwordBranch.slice(duplicateStart, duplicateEnd);
  assertIncludes(duplicateBranch, "status: 'pending_confirmation'");
  if (duplicateBranch.includes("sendSignupConfirmation")) {
    throw new Error("duplicate-account state changes whether the anonymous endpoint attempts Auth delivery");
  }
});

Deno.test("a confirmation-send failure stays generic to anonymous callers", () => {
  assertIncludes(source, "code: 'confirmation_delivery_failed'");
  const failureStart = source.indexOf("code: 'confirmation_delivery_failed'");
  const failureEnd = source.indexOf("}, 503)", failureStart);
  const failure = source.slice(failureStart, failureEnd);
  for (const forbidden of ["confirmationError.message", "ownerEmail", "detail:"]) {
    if (failure.includes(forbidden)) {
      throw new Error(`anonymous confirmation failure exposes ${forbidden}`);
    }
  }
});

/**
 * Owner ruling #332, asserted on the SOURCE because the alternative is a live GoTrue.
 *
 * Two things have to stay true together, and each one alone is a hole: the request body's
 * `password` must not be read (or a stranger's password reaches the account), and the input handed
 * to `provisionTenant` must declare `passwordPending` (or `validateProvisionInput` refuses the
 * payload and signup stops working at all).
 */
Deno.test("the anonymous signup neither reads a password nor forgets to say so", () => {
  const passwordBranch = source.slice(source.indexOf("const input = {"));
  const inputLiteral = passwordBranch.slice(0, passwordBranch.indexOf("};") + 2);

  if (/body\.password/.test(inputLiteral)) {
    throw new Error("the anonymous signup still reads a password from the request body");
  }
  assertIncludes(inputLiteral, "passwordPending: true");
  assertIncludes(inputLiteral, "emailConfirmed: false");
});
