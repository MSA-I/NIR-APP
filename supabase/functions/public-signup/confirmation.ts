export interface SignupConfirmationError {
  message: string;
}

export interface SignupConfirmationClient {
  auth: {
    resend(input: { type: 'signup'; email: string }): PromiseLike<{
      data: unknown;
      error: SignupConfirmationError | null;
    }>;
  };
}

/**
 * `auth.admin.createUser` creates the unconfirmed identity but deliberately sends no mail.
 * Confirmation remains owned by Supabase Auth and its configured SMTP: this explicit resend call
 * asks GoTrue to mint the confirmation link, apply its email-rate limit and hand it to Resend.
 */
export async function sendSignupConfirmation(
  client: SignupConfirmationClient,
  email: string,
): Promise<{ data: unknown; error: SignupConfirmationError | null }> {
  return await client.auth.resend({ type: 'signup', email });
}
