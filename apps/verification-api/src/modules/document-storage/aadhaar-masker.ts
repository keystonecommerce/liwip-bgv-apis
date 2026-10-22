import { Inject, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { SniffedType, sniffFileType } from "../../domain/file-types";
import type { CheckFile } from "../../domain/supplementary-checks";
import { VERIFICATION_PROVIDER, VerificationProvider } from "../../integrations/verification-provider";
import { providerCallContext } from "../usage/provider-call.context";

const MAX_MASKED_BYTES = 25 * 1024 * 1024;

/** Hosts Surepass serves masked images from (SUREPASS_MASKED_IMAGE_HOSTS, comma-separated; default its S3). */
function allowedHost(url: URL): boolean {
  const hosts = String(process.env.SUREPASS_MASKED_IMAGE_HOSTS || "amazonaws.com").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  const listed = hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  // Plain http only for a listed local address (the Surepass mock in tests).
  return listed && (url.protocol === "https:" || (url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost")));
}

export interface MaskOwner { tenantId: string; clientId: string; applicationId: string; documentId: string }

/**
 * Masks an Aadhaar image with Surepass (the first eight digits hidden) and fetches the masked copy.
 * Throws 422 when Surepass cannot mask it and 503 when masking is unavailable.
 */
@Injectable()
export class AadhaarMasker {
  private readonly logger = new Logger(AadhaarMasker.name);

  constructor(@Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider) {}

  async mask(file: CheckFile, owner: MaskOwner): Promise<{ bytes: Buffer; contentType: SniffedType }> {
    let data: Record<string, unknown> | null | undefined;
    try {
      // Recorded against the case like any other provider call.
      const context = { tenantId: owner.tenantId, clientId: owner.clientId, applicationId: owner.applicationId, operationKey: `aadhaar_mask_${owner.documentId}` };
      data = (await providerCallContext.run(context, () => this.provider.executeCheck("AADHAAR_MASK", {}, { file }))).data;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "PROVIDER_HTTP_ERROR") throw new UnprocessableEntityException("We could not mask this Aadhaar image, so it was not kept. Upload a clearer copy.");
      throw new ServiceUnavailableException("Aadhaar masking is unavailable, so the image was not kept. Try again later.");
    }
    let url: URL;
    try {
      url = new URL(String(data?.masked_image ?? ""));
    } catch {
      throw new ServiceUnavailableException("Aadhaar masking returned no image, so the upload was not kept. Try again later.");
    }
    if (!allowedHost(url)) {
      this.logger.warn(`Refused a masked Aadhaar image from ${url.hostname}`);
      throw new ServiceUnavailableException("Aadhaar masking returned an unexpected link, so the upload was not kept.");
    }
    let bytes: Buffer;
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get("content-length") || 0) > MAX_MASKED_BYTES) throw new Error("too large");
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      this.logger.warn(`Could not fetch the masked Aadhaar image for document=${owner.documentId}: ${error instanceof Error ? error.message : "unknown"}`);
      throw new ServiceUnavailableException("Aadhaar masking is unavailable, so the image was not kept. Try again later.");
    }
    const contentType = sniffFileType(bytes);
    if (!contentType || bytes.length > MAX_MASKED_BYTES) throw new ServiceUnavailableException("Aadhaar masking returned an unreadable file, so the upload was not kept.");
    return { bytes, contentType };
  }
}
