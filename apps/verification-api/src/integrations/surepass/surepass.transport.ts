import { Inject, Injectable } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import { ProviderCallService } from "../../modules/usage/provider-call.service";
import { assertProductEnabled } from "./products";

export interface SurepassRequest {
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown> | FormData;
}

/** One transport for every endpoint. Never retry paid requests here. */
@Injectable()
export class SurepassTransport {
  constructor(@Inject(ProviderCallService) private readonly calls: ProviderCallService) {}

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
    // Plain HTTP only to loopback, for the local mock (tools/surepass-mock). It never leaves the machine.
    const localMock = base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname);
    if ((base.protocol !== "https:" && !localMock) || base.username || base.password) {
      throw new UnrecoverableError("SUREPASS_BASE_URL must be an HTTPS URL without credentials");
    }
    const timeout = Number(process.env.SUREPASS_TIMEOUT_MS || 30000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
      throw new UnrecoverableError("SUREPASS_TIMEOUT_MS must be between 1000 and 120000");
    }
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith("/api/v1/")) throw new UnrecoverableError("Invalid provider endpoint");
    assertProductEnabled(url.pathname);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (process.env.SUREPASS_CUSTOMER_ID) headers.set("X-Customer-Id", process.env.SUREPASS_CUSTOMER_ID);
    // The ledger records the call before it goes out, so a paid call is never replayed blindly.
    return this.calls.dispatch("surepass", url.pathname, async () => {
      try {
        return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeout), redirect: "error" });
      } catch {
        // The provider may have processed a timed-out POST. Retrying can charge twice.
        throw Object.assign(new UnrecoverableError("Provider request outcome is unknown; review before retrying"), { code: "PROVIDER_OUTCOME_UNKNOWN" });
      }
    });
  }
}
