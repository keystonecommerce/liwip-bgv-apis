import { BadGatewayException, BadRequestException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ClientContext } from "../../common/auth/client-context";
import type { DigiLockerInitializeData, DigiLockerInitializeProviderResponse } from "../../integrations/surepass/digilocker.types";
import { SurepassProvider } from "../../integrations/surepass/surepass.provider";

type DigiLockerInitializeRequest = { data?: Partial<DigiLockerInitializeData> };

@Injectable()
export class DigiLockerService {
  constructor(@Inject(SurepassProvider) private readonly provider: SurepassProvider) {}

  async initialize(request: DigiLockerInitializeRequest, client: ClientContext) {
    const data = this.validateAndNormalise(request?.data || {});
    const state = data.state || `dl_${client.clientCode}_${randomUUID()}`.slice(0, 100);
    const result = await this.provider.initializeDigiLocker({ ...data, state });
    const body = result.body as DigiLockerInitializeProviderResponse | null;

    if (result.statusCode >= 400 || body?.success === false) {
      throw new BadGatewayException({
        message: body?.message || "DigiLocker session could not be created",
        provider_status: body?.status_code || result.statusCode,
        message_code: body?.message_code
      });
    }
    if (!body?.data?.client_id || !body.data.token || !body.data.url || !body.data.expiry_seconds) {
      throw new BadGatewayException("DigiLocker returned an incomplete initialization response");
    }

    return {
      client_id: body.data.client_id,
      token: body.data.token,
      url: body.data.url,
      expiry_seconds: body.data.expiry_seconds,
      state
    };
  }

  private validateAndNormalise(input: Partial<DigiLockerInitializeData>): DigiLockerInitializeData {
    if (typeof input.signup_flow !== "boolean") {
      throw new BadRequestException("data.signup_flow must be true or false");
    }
    if (input.auth_type && !["web", "app"].includes(input.auth_type)) {
      throw new BadRequestException("data.auth_type must be web or app");
    }
    if (input.expiry_minutes !== undefined && (!Number.isInteger(input.expiry_minutes) || input.expiry_minutes < 5 || input.expiry_minutes > 30)) {
      throw new BadRequestException("data.expiry_minutes must be an integer from 5 to 30");
    }
    if (input.retry_count !== undefined && (!Number.isInteger(input.retry_count) || input.retry_count < 1 || input.retry_count > 5)) {
      throw new BadRequestException("data.retry_count must be an integer from 1 to 5");
    }
    if (input.voice_assistant_lang && !["hi", "en", "both"].includes(input.voice_assistant_lang)) {
      throw new BadRequestException("data.voice_assistant_lang must be hi, en, or both");
    }
    if (input.state && input.state.length > 100) {
      throw new BadRequestException("data.state must not exceed 100 characters");
    }

    const prefill = input.prefill_options;
    if (prefill?.full_name && prefill.full_name.length > 250) {
      throw new BadRequestException("data.prefill_options.full_name must not exceed 250 characters");
    }
    if (prefill?.mobile_number && !/^\d{10}$/.test(prefill.mobile_number)) {
      throw new BadRequestException("data.prefill_options.mobile_number must be a 10-digit number");
    }
    if (prefill?.user_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prefill.user_email)) {
      throw new BadRequestException("data.prefill_options.user_email must be a valid email address");
    }

    const redirectUrl = input.redirect_url || process.env.DIGILOCKER_REDIRECT_URL || undefined;
    const webhookUrl = input.webhook_url || process.env.DIGILOCKER_WEBHOOK_URL || undefined;
    const logoUrl = input.logo_url || process.env.DIGILOCKER_LOGO_URL || undefined;
    this.validateUrl("data.redirect_url", redirectUrl);
    this.validateUrl("data.webhook_url", webhookUrl);
    this.validateUrl("data.local_frontend_url", input.local_frontend_url);
    this.validateUrl("data.logo_url", logoUrl);

    return {
      signup_flow: input.signup_flow,
      auth_type: input.auth_type || "web",
      verify_phone: input.verify_phone ?? false,
      verify_email: input.verify_email ?? false,
      allow_selection: input.allow_selection ?? false,
      aadhaar_xml: input.aadhaar_xml ?? true,
      send_sms: input.send_sms ?? false,
      send_email: input.send_email ?? false,
      expiry_minutes: input.expiry_minutes ?? 10,
      voice_assistant: input.voice_assistant ?? false,
      voice_assistant_lang: input.voice_assistant_lang || "en",
      retry_count: input.retry_count ?? 1,
      skip_main_screen: input.skip_main_screen ?? false,
      ...(prefill ? { prefill_options: prefill } : {}),
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.local_frontend_url ? { local_frontend_url: input.local_frontend_url } : {}),
      ...(logoUrl ? { logo_url: logoUrl } : {})
    };
  }

  private validateUrl(field: string, value?: string): void {
    if (!value) return;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
    } catch {
      throw new BadRequestException(`${field} must be a valid HTTP or HTTPS URL`);
    }
  }
}
