import { Injectable } from "@nestjs/common";
import { Msg91ApiResponse, Msg91ProviderError } from "./msg91.types";

@Injectable()
export class Msg91OtpProvider {
  async sendOtp(mobile: string, code: string): Promise<Msg91ApiResponse> {
    const { endpoint, authKey, templateId, senderId } = this.configuration();
    return this.request(endpoint, authKey, {
      template_id: templateId,
      sender: senderId,
      short_url: "0",
      recipients: [{ mobiles: mobile, code }]
    });
  }

  private configuration() {
    const endpoint = (process.env.MSG91_SMS_ENDPOINT || "https://control.msg91.com/api/v5/flow/").trim();
    const authKey = (process.env.MSG91_AUTHKEY || process.env.MSG91_AUTH_KEY || "").trim();
    const templateId = (process.env.MSG91_OTP_TEMPLATE_ID || "").trim();
    const senderId = (process.env.MSG91_SENDER_ID || process.env.MSG91_DEFAULT_SENDER || "").trim();
    if (!endpoint || !authKey || !templateId || !senderId) {
      throw new Msg91ProviderError("MSG91 Flow configuration is incomplete", 503);
    }
    return { endpoint, authKey, templateId, senderId };
  }

  private async request(endpoint: string, authKey: string, payload: Record<string, unknown>): Promise<Msg91ApiResponse> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authkey: authKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new Msg91ProviderError("MSG91 Flow service is currently unreachable", 503);
    }

    const body = await this.readBody(response);
    const providerRejected = body.type?.toLowerCase() === "error" || body.success === false;
    if (!response.ok || providerRejected) {
      throw new Msg91ProviderError(body.message || "MSG91 rejected the Flow request", response.ok ? 400 : response.status, body);
    }
    return body;
  }

  private async readBody(response: Response): Promise<Msg91ApiResponse> {
    const text = await response.text();
    if (!text) return {};
    try {
      const body = JSON.parse(text) as unknown;
      return body && typeof body === "object" ? body as Msg91ApiResponse : { message: text };
    } catch {
      return { message: text };
    }
  }
}
