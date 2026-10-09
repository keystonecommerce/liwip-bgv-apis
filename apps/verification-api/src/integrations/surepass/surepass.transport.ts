import { Injectable } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";

export interface SurepassRequest {
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown> | FormData;
}

/** One transport for every endpoint. Never retry paid requests here. */
@Injectable()
export class SurepassTransport {
  async send(path: string, init: RequestInit) {
    const response = await this.fetch(path, init);
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async request(request: SurepassRequest) {
    return this.send(request.path, {
      method: request.method || "POST",
      body: request.body instanceof FormData ? request.body : request.body ? JSON.stringify(request.body) : undefined,
      headers: request.body && !(request.body instanceof FormData) ? { "content-type": "application/json" } : undefined
    });
  }

  async fetch(path: string, init: RequestInit): Promise<Response> {
    const token = process.env.SUREPASS_BEARER_TOKEN;
    if (!token || token.startsWith("replace-with-")) {
      throw Object.assign(new UnrecoverableError("Surepass credentials are not configured"), { code: "PROVIDER_CONFIGURATION_ERROR" });
    }
    const base = new URL(process.env.SUREPASS_BASE_URL || "https://sandbox.surepass.app");
    if (base.protocol !== "https:" || base.username || base.password) {
      throw new UnrecoverableError("SUREPASS_BASE_URL must be an HTTPS URL without credentials");
    }
    const timeout = Number(process.env.SUREPASS_TIMEOUT_MS || 30000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
      throw new UnrecoverableError("SUREPASS_TIMEOUT_MS must be between 1000 and 120000");
    }
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith("/api/v1/")) throw new UnrecoverableError("Invalid provider endpoint");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (process.env.SUREPASS_CUSTOMER_ID) headers.set("X-Customer-Id", process.env.SUREPASS_CUSTOMER_ID);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeout),
        redirect: "error"
      });
    } catch {
      // The provider may have processed a timed-out POST. Retrying can charge twice.
      throw Object.assign(new UnrecoverableError("Provider request outcome is unknown; review before retrying"), { code: "PROVIDER_OUTCOME_UNKNOWN" });
    }
    return response;
  }
}
