import { sendSignupConfirmation } from "./confirmation.ts";

Deno.test("signup confirmation asks Supabase Auth to resend a signup email", async () => {
  const calls: unknown[] = [];
  const client = {
    auth: {
      resend(input: unknown) {
        calls.push(input);
        return Promise.resolve({ data: {}, error: null });
      },
    },
  };

  const result = await sendSignupConfirmation(client, "owner@example.test");

  if (result.error) throw new Error(`confirmation failed: ${result.error.message}`);
  const sent = JSON.stringify(calls);
  if (sent !== JSON.stringify([{ type: "signup", email: "owner@example.test" }])) {
    throw new Error(`unexpected Auth resend request: ${sent}`);
  }
});

Deno.test("signup confirmation reports Auth delivery rejection to its caller", async () => {
  const expected = { message: "smtp refused" };
  const client = {
    auth: {
      resend: () => Promise.resolve({ data: null, error: expected }),
    },
  };

  const result = await sendSignupConfirmation(client, "owner@example.test");
  if (result.error !== expected) {
    throw new Error("the Auth delivery error was hidden or replaced");
  }
});
