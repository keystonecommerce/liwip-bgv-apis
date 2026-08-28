import { Prisma } from "@prisma/client";
import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ClientContext } from "../../common/auth/client-context";
import { PrismaService } from "../../common/database/prisma.service";
import type {
  AadhaarOvseInitializeData,
  AadhaarOvseInitializeProviderResponse,
  AadhaarOvseResultData,
  AadhaarOvseResultProviderResponse,
  AadhaarOvseStatus,
  AadhaarOvseStatusProviderResponse
} from "../../integrations/surepass/aadhaar-ovse.types";
import { SurepassProvider } from "../../integrations/surepass/surepass.provider";

const DEFAULT_CLAIMS = ["full_name", "dob", "gender", "profile_image", "care_of", "address", "pincode", "age_above_18", "mobile", "email"];
const OVSE_STATUSES = new Set<AadhaarOvseStatus>(["pending", "callback_received", "completed", "failed", "expired"]);
const TERMINAL_STATUSES = new Set<AadhaarOvseStatus>(["completed", "failed", "expired"]);

@Injectable()
export class AadhaarOvseService {
  constructor(
    @Inject(SurepassProvider) private readonly provider: SurepassProvider,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async initialize(input: Partial<AadhaarOvseInitializeData>, client: ClientContext) {
    const payload = this.validateAndNormalise(input || {});
    const referenceId = payload.reference_id || `ovse_${client.clientCode}_${randomUUID()}`.slice(0, 100);
    const result = await this.provider.initializeAadhaarOvse({ ...payload, reference_id: referenceId });
    const body = result.body as unknown as AadhaarOvseInitializeProviderResponse | null;

    if (result.statusCode >= 400 || body?.success === false) {
      this.throwProviderError(result.statusCode, body, "Aadhaar OVSE session could not be created");
    }
    if (!body?.data?.client_id) throw new BadGatewayException("Aadhaar OVSE returned an incomplete initialization response");
    if (payload.channel === "qr" && !body.data.qr_data) throw new BadGatewayException("Aadhaar OVSE did not return QR data");
    if (payload.channel === "web" && !body.data.web_link) throw new BadGatewayException("Aadhaar OVSE did not return a web link");
    if (payload.channel === "app" && !body.data.intent_data) throw new BadGatewayException("Aadhaar OVSE did not return app intent data");

    const status = this.normaliseStatus(body.data.status) || "pending";
    await this.prisma.aadhaarOvseSession.create({
      data: {
        id: `aadhaar_ovse_${randomUUID()}`,
        tenantId: client.tenantId,
        clientId: client.clientId,
        providerClientId: body.data.client_id,
        referenceId,
        channel: body.data.channel || payload.channel,
        status,
        requestedClaims: (payload.claims || DEFAULT_CLAIMS) as Prisma.InputJsonValue
      }
    });

    return {
      client_id: body.data.client_id,
      channel: body.data.channel || payload.channel,
      status,
      qr_data: body.data.qr_data || null,
      intent_data: body.data.intent_data,
      web_link: body.data.web_link || null,
      reference_id: referenceId
    };
  }

  async status(providerClientId: string, client: ClientContext) {
    const session = await this.findOwnedSession(providerClientId, client);
    const storedStatus = this.normaliseStatus(session.status);
    if (storedStatus && TERMINAL_STATUSES.has(storedStatus)) {
      return this.statusResponse(session.providerClientId, storedStatus, session.statusDescription);
    }

    const result = await this.provider.getAadhaarOvseStatus(session.providerClientId);
    const body = result.body as unknown as AadhaarOvseStatusProviderResponse | null;
    if (result.statusCode >= 400 || body?.success === false) {
      this.throwProviderError(result.statusCode, body, "Aadhaar OVSE status could not be retrieved");
    }
    const providerStatus = this.normaliseStatus(body?.data?.status);
    if (!body?.data?.client_id || !providerStatus) throw new BadGatewayException("Aadhaar OVSE returned an incomplete status response");

    const updated = await this.prisma.aadhaarOvseSession.update({
      where: { id: session.id },
      data: {
        status: providerStatus,
        statusDescription: body.data.status_description || null,
        ...(providerStatus === "completed" ? { completedAt: new Date() } : {})
      }
    });
    return this.statusResponse(updated.providerClientId, providerStatus, updated.statusDescription);
  }

  async result(providerClientId: string, client: ClientContext): Promise<AadhaarOvseResultData> {
    const session = await this.findOwnedSession(providerClientId, client);
    if (session.result) return session.result as unknown as AadhaarOvseResultData;
    if (session.status !== "completed") {
      throw new BadRequestException(`Aadhaar OVSE result is not ready. Current status: ${session.status}. Check the status endpoint first.`);
    }

    const response = await this.provider.getAadhaarOvseResult(session.providerClientId);
    const body = response.body as unknown as AadhaarOvseResultProviderResponse | null;
    if (response.statusCode >= 400 || body?.success === false) {
      this.throwProviderError(response.statusCode, body, "Aadhaar OVSE result could not be retrieved");
    }
    if (!body?.data?.client_id || body.data.status !== "completed") throw new BadGatewayException("Aadhaar OVSE returned an incomplete result response");

    await this.prisma.aadhaarOvseSession.update({
      where: { id: session.id },
      data: {
        status: "completed",
        result: body.data as Prisma.InputJsonValue,
        completedAt: session.completedAt || new Date(),
        resultRetrievedAt: new Date()
      }
    });
    return body.data;
  }

  private async findOwnedSession(providerClientId: string, client: ClientContext) {
    if (!providerClientId?.trim()) throw new BadRequestException("client_id is required");
    const session = await this.prisma.aadhaarOvseSession.findFirst({
      where: { providerClientId: providerClientId.trim(), tenantId: client.tenantId, clientId: client.clientId }
    });
    if (!session) throw new NotFoundException("Aadhaar OVSE session was not found for this client");
    return session;
  }

  private statusResponse(clientId: string, status: AadhaarOvseStatus, description?: string | null) {
    return { client_id: clientId, status, status_description: description || null };
  }

  private normaliseStatus(value?: string | null): AadhaarOvseStatus | null {
    return value && OVSE_STATUSES.has(value as AadhaarOvseStatus) ? value as AadhaarOvseStatus : null;
  }

  private throwProviderError(statusCode: number, body: { message?: string; status_code?: number; message_code?: string } | null | undefined, fallback: string): never {
    throw new BadGatewayException({ message: body?.message || fallback, provider_status: body?.status_code || statusCode, message_code: body?.message_code });
  }

  private validateAndNormalise(input: Partial<AadhaarOvseInitializeData>): AadhaarOvseInitializeData & { channel: "qr" | "app" | "web" } {
    const channel = input.channel || "qr";
    if (!["qr", "app", "web"].includes(channel)) throw new BadRequestException("channel must be qr, app, or web");
    const authMode = input.auth_mode || "1";
    if (!["0", "1"].includes(authMode)) throw new BadRequestException("auth_mode must be 0 or 1");
    if (channel === "app" && !input.app_signature?.trim()) throw new BadRequestException("app_signature is required when channel is app");
    if (input.hint && input.hint.length > 100) throw new BadRequestException("hint must not exceed 100 characters");
    if (input.app_signature && input.app_signature.length > 200) throw new BadRequestException("app_signature must not exceed 200 characters");
    const webhookUrl = input.webhook_url || process.env.AADHAAR_OVSE_WEBHOOK_URL || undefined;
    const redirectUrl = input.redirect_url || process.env.AADHAAR_OVSE_REDIRECT_URL || undefined;
    if (webhookUrl && webhookUrl.length > 500) throw new BadRequestException("webhook_url must not exceed 500 characters");
    if (redirectUrl && redirectUrl.length > 500) throw new BadRequestException("redirect_url must not exceed 500 characters");
    this.validateUrl("webhook_url", webhookUrl);
    this.validateUrl("redirect_url", redirectUrl);

    const claims = input.claims?.length ? input.claims : DEFAULT_CLAIMS;
    if (claims.length > 20 || claims.some((claim) => !/^[a-z][a-z0-9_]{0,49}$/.test(claim))) {
      throw new BadRequestException("claims must contain valid lowercase claim names");
    }

    return {
      channel,
      claims: [...new Set(claims)],
      auth_mode: authMode,
      language: input.language || "23",
      ...(input.hint?.trim() ? { hint: input.hint.trim() } : {}),
      ...(input.app_signature?.trim() ? { app_signature: input.app_signature.trim() } : {}),
      ...(webhookUrl?.trim() ? { webhook_url: webhookUrl.trim() } : {}),
      ...(redirectUrl?.trim() ? { redirect_url: redirectUrl.trim() } : {}),
      ...(input.reference_id?.trim() ? { reference_id: input.reference_id.trim() } : {})
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
