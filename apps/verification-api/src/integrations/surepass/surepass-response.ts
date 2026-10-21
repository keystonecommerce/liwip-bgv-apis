import { UnrecoverableError } from "bullmq";
import type { ProviderResponse, RawProviderResponse } from "../verification-provider";
import type { Verdict } from "./verdicts";

/**
 * Surepass envelope → check result. Provider rejections and malformed successes become
 * errors the queue understands; a success is judged by `verdict` (review when none).
 */
export function toProviderResponse(raw: RawProviderResponse, label: string, verdict?: Verdict): ProviderResponse {
  const body = raw.body as {
    success?: boolean;
    data?: Record<string, unknown> | null;
    message?: string;
    message_code?: string;
    status_code?: number;
  } | null;
  if (raw.statusCode >= 400 || body?.success === false || (typeof body?.status_code === "number" && body.status_code >= 400)) {
    const message = `Surepass ${label} could not complete the check (HTTP ${raw.statusCode})`;
    const effectiveStatus = typeof body?.status_code === "number" ? body.status_code : raw.statusCode;
    const error = (effectiveStatus !== 429
      ? new UnrecoverableError(message)
      : new Error(message)) as Error & { code?: string; providerResponse?: Record<string, unknown> | null };
    error.code = effectiveStatus === 429 || effectiveStatus >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_HTTP_ERROR";
    error.providerResponse = { status_code: effectiveStatus, success: body?.success ?? false, message_code: body?.message_code ?? null, message: typeof body?.message === "string" ? body.message.slice(0, 200) : null };
    throw error;
  }
  if (body?.success !== true || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    const error = new UnrecoverableError(`Surepass ${label} returned an incomplete response; review before retrying`) as Error & { code?: string };
    error.code = "PROVIDER_OUTCOME_UNKNOWN";
    throw error;
  }
  return {
    requestId: typeof body.data.client_id === "string" ? body.data.client_id : undefined,
    status: verdict ? verdict(body.data) : "manual_review",
    data: body.data
  };
}
