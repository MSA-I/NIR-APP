import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  databaseErrorCode,
  isRecoveryResult,
  parseRecoveryRequest,
  type RecoveryErrorCode,
  type RecoveryOutcome,
  RequestValidationError,
  shouldInvokeInterpretDocument,
} from "./core.ts";

export const DATABASE_TIMEOUT_MS = 15_000;
export const INTERPRET_DOCUMENT_TIMEOUT_MS = 70_000;

const MESSAGE: Record<RecoveryErrorCode, string> = {
  unauthenticated: "נדרשת התחברות מחדש לפני שחזור העיבוד.",
  not_authorized: "רק מנהל פעיל של העסק יכול לשחזר עיבוד מסמך.",
  invalid_request: "בקשת שחזור העיבוד אינה תקינה.",
  organization_read_only:
    "העסק נמצא כרגע במצב קריאה בלבד, ולכן אי אפשר לשחזר עיבוד מסמכים.",
  job_not_recoverable:
    "משימת העיבוד השתנתה או שאינה תקועה עוד. רעננו את הרשימה ונסו שוב.",
  recovery_in_progress:
    "העיבוד עדיין מחזיק הרשאה פעילה. המתינו לרענון הבא לפני ניסיון שחזור נוסף.",
  request_conflict: "מזהה בקשת השחזור כבר שימש לפעולה אחרת.",
  service_unavailable: "שירות שחזור העיבוד אינו זמין כרגע. נסו שוב מאוחר יותר.",
};

const STATUS: Record<RecoveryErrorCode, number> = {
  unauthenticated: 401,
  not_authorized: 403,
  invalid_request: 400,
  organization_read_only: 409,
  job_not_recoverable: 409,
  recovery_in_progress: 409,
  request_conflict: 409,
  service_unavailable: 503,
};

interface UserLookup {
  id: string | null;
  error: boolean;
}

interface ProfileLookup {
  data: { org_id: string; role: string; active: boolean } | null;
  error: { code?: string; message?: string } | null;
}

interface RecoveryLookup {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

export interface RecoveryHandlerDependencies {
  getEnv(name: string): string | undefined;
  getUser(input: {
    url: string;
    anonKey: string;
    authorization: string;
  }): Promise<UserLookup>;
  getProfile(input: {
    url: string;
    serviceKey: string;
    userId: string;
  }): Promise<ProfileLookup>;
  recover(input: {
    url: string;
    serviceKey: string;
    jobId: string;
    actorId: string;
    requestId: string;
    reason: string;
  }): Promise<RecoveryLookup>;
  invokeInterpretDocument(input: {
    url: string;
    anonKey: string;
    cronSecret: string;
    jobId: string;
  }): Promise<boolean>;
}

const defaultDependencies: RecoveryHandlerDependencies = {
  getEnv: (name) => Deno.env.get(name),
  async getUser({ url, anonKey, authorization }) {
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const result = await caller.auth.getUser();
    return { id: result.data.user?.id ?? null, error: Boolean(result.error) };
  },
  async getProfile({ url, serviceKey, userId }) {
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
          }),
      },
    });
    const result = await admin.from("profiles")
      .select("org_id,role,active")
      .eq("id", userId)
      .maybeSingle();
    return {
      data: result.data as ProfileLookup["data"],
      error: result.error,
    };
  },
  async recover({
    url,
    serviceKey,
    jobId,
    actorId,
    requestId,
    reason,
  }) {
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
          }),
      },
    });
    const result = await admin.rpc(
      "service_recover_stuck_document_processing",
      {
        p_job_id: jobId,
        p_actor_id: actorId,
        p_request_id: requestId,
        p_reason: reason,
      },
    );
    return { data: result.data, error: result.error };
  },
  async invokeInterpretDocument({ url, anonKey, cronSecret, jobId }) {
    const response = await fetch(
      `${url.replace(/\/+$/, "")}/functions/v1/interpret-document`,
      {
        method: "POST",
        headers: {
          apikey: anonKey,
          "content-type": "application/json",
          "x-interpret-cron-secret": cronSecret,
        },
        body: JSON.stringify({ jobId }),
        // This handoff may include the bounded model call in interpret-document.
        signal: AbortSignal.timeout(INTERPRET_DOCUMENT_TIMEOUT_MS),
      },
    );
    return response.ok;
  },
};

function corsFor(
  req: Request,
  getEnv: RecoveryHandlerDependencies["getEnv"],
): Record<string, string> {
  const allowed = (getEnv("ALLOWED_ORIGINS") ?? getEnv("APP_BASE_URL") ?? "")
    .split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(
      Boolean,
    );
  const origin = req.headers.get("Origin")?.replace(/\/+$/, "") ?? "";
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin)
      ? origin
      : (allowed[0] ?? ""),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-correlation-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(
  cors: Record<string, string>,
  body: unknown,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function fail(cors: Record<string, string>, code: RecoveryErrorCode): Response {
  return json(cors, { error: { code, message: MESSAGE[code] } }, STATUS[code]);
}

interface PublicRecoveryResult {
  outcome: RecoveryOutcome;
  job_id: string;
  idempotent: boolean;
}

function publicResult(result: {
  outcome: RecoveryOutcome;
  job_id: string;
  idempotent: boolean;
}): PublicRecoveryResult {
  return {
    outcome: result.outcome,
    job_id: result.job_id,
    idempotent: result.idempotent,
  };
}

export function createRecoveryHandler(
  dependencies: RecoveryHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cors = corsFor(req, dependencies.getEnv);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return fail(cors, "invalid_request");

    const url = dependencies.getEnv("SUPABASE_URL");
    const anonKey = dependencies.getEnv("SUPABASE_ANON_KEY");
    const serviceKey = dependencies.getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) {
      return fail(cors, "service_unavailable");
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return fail(cors, "unauthenticated");
    }

    let user: UserLookup;
    try {
      user = await dependencies.getUser({ url, anonKey, authorization });
    } catch {
      return fail(cors, "service_unavailable");
    }
    if (user.error || !user.id) return fail(cors, "unauthenticated");

    let body;
    try {
      body = parseRecoveryRequest(await req.json());
    } catch (error) {
      if (
        error instanceof RequestValidationError || error instanceof SyntaxError
      ) {
        return fail(cors, "invalid_request");
      }
      return fail(cors, "service_unavailable");
    }

    let profile: ProfileLookup;
    try {
      profile = await dependencies.getProfile({
        url,
        serviceKey,
        userId: user.id,
      });
    } catch {
      return fail(cors, "service_unavailable");
    }
    if (profile.error) return fail(cors, "service_unavailable");
    if (!profile.data?.active || profile.data.role !== "owner") {
      return fail(cors, "not_authorized");
    }

    let recovered: RecoveryLookup;
    try {
      recovered = await dependencies.recover({
        url,
        serviceKey,
        jobId: body.job_id,
        actorId: user.id,
        requestId: body.request_id,
        reason: body.reason,
      });
    } catch {
      return fail(cors, "service_unavailable");
    }
    if (recovered.error) return fail(cors, databaseErrorCode(recovered.error));
    if (
      !isRecoveryResult(recovered.data) ||
      recovered.data.old_job_id !== body.job_id
    ) {
      return fail(cors, "service_unavailable");
    }

    if (shouldInvokeInterpretDocument(recovered.data.outcome)) {
      const cronSecret = dependencies.getEnv("INTERPRET_DOCUMENT_CRON_SECRET");
      if (!cronSecret) return fail(cors, "service_unavailable");
      try {
        const invoked = await dependencies.invokeInterpretDocument({
          url,
          anonKey,
          cronSecret,
          jobId: recovered.data.job_id,
        });
        if (!invoked) return fail(cors, "service_unavailable");
      } catch {
        return fail(cors, "service_unavailable");
      }
    }

    return json(cors, publicResult(recovered.data), 200);
  };
}

export const handler = createRecoveryHandler(defaultDependencies);

if (import.meta.main) Deno.serve(handler);
