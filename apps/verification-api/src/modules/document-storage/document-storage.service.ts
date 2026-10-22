import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import type { ApplicationDocument } from "@prisma/client";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import type { ClientContext } from "../../common/auth/client-context";
import { PrismaService } from "../../common/database/prisma.service";
import { AadhaarMasker } from "./aadhaar-masker";
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  CreateDocumentUploadRequest,
  DOCUMENT_TYPES,
  DocumentType
} from "./document-storage.types";

export interface StorageConfiguration {
  region: string;
  bucket: string;
  kmsKeyArn: string;
  presignedUrlExpirySeconds: number;
  retentionDays: number;
  maxDocumentSizeBytes: number;
}

@Injectable()
export class DocumentStorageService {
  private readonly logger = new Logger(DocumentStorageService.name);
  private client?: S3Client;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AadhaarMasker) private readonly masker: AadhaarMasker
  ) {}

  async createUploadUrl(applicationId: string, request: CreateDocumentUploadRequest, client: ClientContext) {
    await this.ensureOwnedApplication(applicationId, client);
    const config = this.configuration();
    const input = this.validateUploadRequest(request, config.maxDocumentSizeBytes);
    const id = `doc_${randomUUID()}`;
    const objectKey = `temporary/tenants/${client.tenantId}/clients/${client.clientId}/applications/${applicationId}/documents/${id}`;
    const expiresAt = new Date(Date.now() + config.retentionDays * 24 * 60 * 60 * 1000);

    const document = await this.prisma.applicationDocument.create({
      data: {
        id,
        tenantId: client.tenantId,
        clientId: client.clientId,
        applicationId,
        documentType: input.documentType,
        bucket: config.bucket,
        objectKey,
        originalFileName: input.fileName,
        contentType: input.contentType,
        declaredSizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        expiresAt
      }
    });

    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      ContentType: input.contentType,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: config.kmsKeyArn,
      BucketKeyEnabled: true,
      Metadata: { document_id: id },
      ...(input.checksumSha256 ? { ChecksumSHA256: input.checksumSha256 } : {})
    });

    try {
      const url = await getSignedUrl(this.s3(config), command, { expiresIn: config.presignedUrlExpirySeconds });
      return {
        document: this.toPublicDocument(document),
        upload: {
          method: "PUT",
          url,
          expires_in_seconds: config.presignedUrlExpirySeconds,
          headers: {
            "Content-Type": input.contentType,
            "x-amz-server-side-encryption": "aws:kms",
            "x-amz-server-side-encryption-aws-kms-key-id": config.kmsKeyArn,
            "x-amz-server-side-encryption-bucket-key-enabled": "true",
            ...(input.checksumSha256 ? { "x-amz-checksum-sha256": input.checksumSha256 } : {})
          }
        }
      };
    } catch (error) {
      await this.prisma.applicationDocument.delete({ where: { id } });
      this.logger.warn(`Could not create S3 upload URL for document=${id}: ${this.errorName(error)}`);
      throw new ServiceUnavailableException("Secure document upload is temporarily unavailable.");
    }
  }

  async confirmUpload(applicationId: string, documentId: string, client: ClientContext) {
    const document = await this.findOwnedDocument(applicationId, documentId, client);
    if (document.status === "DELETED") throw new ConflictException("This document has been deleted.");
    if (document.status === "UPLOADED") return { document: this.toPublicDocument(document) };
    if (document.status === "MASKING") throw new ConflictException("This Aadhaar image is still being masked.");

    const config = this.configuration();
    let stored;
    try {
      stored = await this.s3(config).send(new HeadObjectCommand({
        Bucket: document.bucket,
        Key: document.objectKey,
        ChecksumMode: "ENABLED"
      }));
    } catch (error) {
      if (this.isNotFound(error)) throw new BadRequestException("The document has not been uploaded to secure storage yet.");
      this.logger.warn(`Could not confirm S3 document=${document.id}: ${this.errorName(error)}`);
      throw new ServiceUnavailableException("Secure document storage is temporarily unavailable.");
    }

    const storedSize = Number(stored.ContentLength || 0);
    const storedType = this.normaliseContentType(stored.ContentType || "");
    if (!storedSize || storedSize !== document.declaredSizeBytes) {
      throw new BadRequestException("The uploaded file size does not match the declared file size.");
    }
    if (storedSize > config.maxDocumentSizeBytes) throw new BadRequestException("The uploaded file is too large.");
    if (storedType !== document.contentType) throw new BadRequestException("The uploaded file type does not match the declared file type.");
    if (stored.ServerSideEncryption !== "aws:kms") throw new BadRequestException("The uploaded file is not encrypted with AWS KMS.");
    if (stored.SSEKMSKeyId && stored.SSEKMSKeyId !== config.kmsKeyArn) {
      throw new BadRequestException("The uploaded file used an unexpected encryption key.");
    }
    if (stored.Metadata?.document_id && stored.Metadata.document_id !== document.id) {
      throw new BadRequestException("The uploaded file metadata does not match this document.");
    }

    if (document.documentType === "AADHAAR") return { document: this.toPublicDocument(await this.keepMasked(document, config, stored.VersionId)) };

    const updated = await this.prisma.applicationDocument.update({
      where: { id: document.id },
      data: {
        status: "UPLOADED",
        sizeBytes: storedSize,
        versionId: stored.VersionId || null,
        etag: stored.ETag?.replaceAll('"', "") || null,
        checksumSha256: stored.ChecksumSHA256 || document.checksumSha256,
        storageEncryption: stored.ServerSideEncryption,
        kmsKeyArn: stored.SSEKMSKeyId || config.kmsKeyArn,
        uploadedAt: new Date()
      }
    });
    return { document: this.toPublicDocument(updated) };
  }

  /**
   * An Aadhaar image is kept only masked. Surepass masks the upload, the masked copy is stored
   * next to it, and the original is deleted (that version, so no copy stays in the bucket). If it
   * cannot be masked the original is deleted all the same and the person uploads again.
   */
  private async keepMasked(document: ApplicationDocument, config: StorageConfiguration, rawVersionId?: string) {
    const claimed = await this.prisma.applicationDocument.updateMany({ where: { id: document.id, status: "PENDING_UPLOAD" }, data: { status: "MASKING" } });
    if (!claimed.count) throw new ConflictException("This Aadhaar image is already being masked.");
    const s3 = this.s3(config);
    const original = { Bucket: document.bucket, Key: document.objectKey, ...(rawVersionId ? { VersionId: rawVersionId } : {}) };
    try {
      const raw = await s3.send(new GetObjectCommand(original));
      const bytes = Buffer.from(await raw.Body!.transformToByteArray());
      const masked = await this.masker.mask(
        { buffer: bytes, originalname: document.originalFileName, mimetype: document.contentType },
        { tenantId: document.tenantId, clientId: document.clientId, applicationId: document.applicationId, documentId: document.id }
      );
      const objectKey = `${document.objectKey}-masked`;
      const put = await s3.send(new PutObjectCommand({
        Bucket: document.bucket, Key: objectKey, Body: masked.bytes, ContentType: masked.contentType,
        ServerSideEncryption: "aws:kms", SSEKMSKeyId: config.kmsKeyArn, BucketKeyEnabled: true,
        Metadata: { document_id: document.id, aadhaar_masked: "true" }
      }));
      await s3.send(new DeleteObjectCommand(original));
      return await this.prisma.applicationDocument.update({
        where: { id: document.id },
        data: {
          status: "UPLOADED", objectKey, contentType: masked.contentType, sizeBytes: masked.bytes.length,
          versionId: put.VersionId || null, etag: put.ETag?.replaceAll('"', "") || null, checksumSha256: null,
          storageEncryption: "aws:kms", kmsKeyArn: config.kmsKeyArn, maskedAt: new Date(), uploadedAt: new Date()
        }
      });
    } catch (error) {
      await s3.send(new DeleteObjectCommand(original)).catch((cleanup) => this.logger.error(`Could not delete the unmasked Aadhaar upload document=${document.id}: ${this.errorName(cleanup)}`));
      await this.prisma.applicationDocument.update({ where: { id: document.id }, data: { status: "DELETED", deletedAt: new Date() } });
      if (error instanceof HttpException) throw error;
      this.logger.warn(`Could not mask Aadhaar document=${document.id}: ${this.errorName(error)}`);
      throw new ServiceUnavailableException("Secure document storage is temporarily unavailable, so the Aadhaar image was not kept.");
    }
  }

  async list(applicationId: string, client: ClientContext) {
    await this.ensureOwnedApplication(applicationId, client);
    const documents = await this.prisma.applicationDocument.findMany({
      where: {
        applicationId,
        tenantId: client.tenantId,
        clientId: client.clientId,
        deletedAt: null
      },
      orderBy: { createdAt: "desc" }
    });
    return documents.map((document) => this.toPublicDocument(document));
  }

  /** Also used by the admin panel, which passes the case owner instead of an API key context. */
  async createDownloadUrl(applicationId: string, documentId: string, client: Pick<ClientContext, "tenantId" | "clientId">) {
    const document = await this.findOwnedDocument(applicationId, documentId, client);
    if (document.status !== "UPLOADED" || document.deletedAt || (document.documentType === "AADHAAR" && !document.maskedAt)) {
      throw new ConflictException("The document is not available for download.");
    }
    const config = this.configuration();
    try {
      const url = await getSignedUrl(this.s3(config), new GetObjectCommand({
        Bucket: document.bucket,
        Key: document.objectKey,
        ResponseContentDisposition: `attachment; filename="${this.downloadFileName(document.originalFileName)}"`
      }), { expiresIn: config.presignedUrlExpirySeconds });
      return { url, expires_in_seconds: config.presignedUrlExpirySeconds };
    } catch (error) {
      this.logger.warn(`Could not create S3 download URL for document=${document.id}: ${this.errorName(error)}`);
      throw new ServiceUnavailableException("Secure document download is temporarily unavailable.");
    }
  }

  async remove(applicationId: string, documentId: string, client: ClientContext) {
    const document = await this.findOwnedDocument(applicationId, documentId, client);
    if (document.status === "DELETED") return { success: true, document_id: document.id, status: "DELETED" };
    const config = this.configuration();
    try {
      await this.s3(config).send(new DeleteObjectCommand({ Bucket: document.bucket, Key: document.objectKey }));
    } catch (error) {
      this.logger.warn(`Could not delete S3 document=${document.id}: ${this.errorName(error)}`);
      throw new ServiceUnavailableException("Secure document deletion is temporarily unavailable.");
    }
    await this.prisma.applicationDocument.update({
      where: { id: document.id },
      data: { status: "DELETED", deletedAt: new Date() }
    });
    return { success: true, document_id: document.id, status: "DELETED" };
  }

  private async ensureOwnedApplication(applicationId: string, client: ClientContext): Promise<void> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId, tenantId: client.tenantId, clientId: client.clientId },
      select: { id: true }
    });
    if (!application) throw new NotFoundException("Application not found.");
  }

  private async findOwnedDocument(applicationId: string, documentId: string, client: Pick<ClientContext, "tenantId" | "clientId">) {
    const document = await this.prisma.applicationDocument.findFirst({
      where: {
        id: documentId,
        applicationId,
        tenantId: client.tenantId,
        clientId: client.clientId
      }
    });
    if (!document) throw new NotFoundException("Document not found.");
    return document;
  }

  private validateUploadRequest(request: CreateDocumentUploadRequest, maxBytes: number) {
    const documentType = String(request?.document_type || "").trim().toUpperCase();
    if (!DOCUMENT_TYPES.includes(documentType as DocumentType)) {
      throw new BadRequestException(`document_type must be one of: ${DOCUMENT_TYPES.join(", ")}`);
    }
    const fileName = this.safeFileName(String(request?.file_name || ""));
    if (!fileName) throw new BadRequestException("file_name is required.");
    const contentType = this.normaliseContentType(String(request?.content_type || ""));
    if (!ALLOWED_DOCUMENT_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException("Unsupported document content_type.");
    }
    const sizeBytes = Number(request?.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes) {
      throw new BadRequestException(`size_bytes must be between 1 and ${maxBytes}.`);
    }
    const checksumSha256 = request?.checksum_sha256?.trim() || undefined;
    if (checksumSha256 && !/^[A-Za-z0-9+/]{43}=$/.test(checksumSha256)) {
      throw new BadRequestException("checksum_sha256 must be a Base64-encoded SHA-256 checksum.");
    }
    return { documentType, fileName, contentType, sizeBytes, checksumSha256 };
  }

  private safeFileName(value: string): string {
    const base = value.split(/[\\/]/).pop() || "";
    return base.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  }

  private downloadFileName(value: string): string {
    return this.safeFileName(value).replace(/[";]/g, "_") || "document";
  }

  private normaliseContentType(value: string): string {
    return value.split(";", 1)[0].trim().toLowerCase();
  }

  private configuration(): StorageConfiguration {
    const region = String(process.env.AWS_REGION || "").trim();
    const bucket = String(process.env.S3_DOCUMENT_BUCKET || "").trim();
    const kmsKeyArn = String(process.env.S3_DOCUMENT_KMS_KEY_ARN || "").trim();
    if (!region || !bucket || !kmsKeyArn) {
      throw new ServiceUnavailableException("Secure document storage is not configured.");
    }
    return {
      region,
      bucket,
      kmsKeyArn,
      presignedUrlExpirySeconds: this.intSetting("S3_PRESIGNED_URL_EXPIRY_SECONDS", 300, 60, 900),
      retentionDays: this.intSetting("S3_TEMP_DOCUMENT_RETENTION_DAYS", 30, 1, 365),
      maxDocumentSizeBytes: this.intSetting("S3_MAX_DOCUMENT_SIZE_BYTES", 15 * 1024 * 1024, 1024, 25 * 1024 * 1024)
    };
  }

  protected s3(config: StorageConfiguration): S3Client {
    this.client ||= new S3Client({ region: config.region });
    return this.client;
  }

  private intSetting(name: string, fallback: number, minimum: number, maximum: number): number {
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
  }

  private isNotFound(error: unknown): boolean {
    const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return value?.name === "NotFound" || value?.name === "NoSuchKey" || value?.$metadata?.httpStatusCode === 404;
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }

  private toPublicDocument(document: ApplicationDocument) {
    return {
      id: document.id,
      application_id: document.applicationId,
      document_type: document.documentType,
      file_name: document.originalFileName,
      content_type: document.contentType,
      declared_size_bytes: document.declaredSizeBytes,
      size_bytes: document.sizeBytes,
      status: document.status,
      checksum_sha256: document.checksumSha256,
      expires_at: document.expiresAt.toISOString(),
      masked: Boolean(document.maskedAt),
      uploaded_at: document.uploadedAt?.toISOString() || null,
      deleted_at: document.deletedAt?.toISOString() || null,
      created_at: document.createdAt.toISOString(),
      updated_at: document.updatedAt.toISOString()
    };
  }
}
