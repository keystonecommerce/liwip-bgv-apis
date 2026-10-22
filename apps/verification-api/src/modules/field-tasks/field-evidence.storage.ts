import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** The bucket name recorded for files kept in the local folder. */
const LOCAL_BUCKET = "local";

/**
 * Where field evidence files live. FIELD_EVIDENCE_LOCAL_DIR, when set, keeps them in that folder
 * (tests, a single server with a disk). Otherwise in S3, encrypted with the documents KMS key, when
 * AWS_REGION, S3_DOCUMENT_BUCKET and S3_DOCUMENT_KMS_KEY_ARN are set; else, outside production only,
 * in ./.data/field-evidence.
 */
@Injectable()
export class FieldEvidenceStorage {
  private readonly logger = new Logger(FieldEvidenceStorage.name);
  private client?: S3Client;

  /** Stores the file and returns the bucket it went to. */
  async put(objectKey: string, bytes: Buffer, contentType: string): Promise<string> {
    const s3 = this.s3Config();
    if (s3) {
      try {
        await this.s3(s3.region).send(new PutObjectCommand({ Bucket: s3.bucket, Key: objectKey, Body: bytes, ContentType: contentType, ServerSideEncryption: "aws:kms", SSEKMSKeyId: s3.kmsKeyArn, BucketKeyEnabled: true }));
        return s3.bucket;
      } catch (error) {
        this.logger.warn(`Could not store field evidence ${objectKey}: ${error instanceof Error ? error.name : "UnknownError"}`);
        throw new ServiceUnavailableException("Evidence storage is temporarily unavailable.");
      }
    }
    const path = this.localPath(objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    return LOCAL_BUCKET;
  }

  async get(bucket: string, objectKey: string): Promise<Buffer> {
    if (bucket === LOCAL_BUCKET) return readFile(this.localPath(objectKey));
    const s3 = this.s3Config();
    if (!s3) throw new ServiceUnavailableException("Evidence storage is not configured.");
    try {
      const object = await this.s3(s3.region).send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
      return Buffer.from(await object.Body!.transformToByteArray());
    } catch (error) {
      this.logger.warn(`Could not read field evidence ${objectKey}: ${error instanceof Error ? error.name : "UnknownError"}`);
      throw new ServiceUnavailableException("Evidence storage is temporarily unavailable.");
    }
  }

  private s3Config() {
    const region = String(process.env.AWS_REGION || "").trim();
    const bucket = String(process.env.S3_DOCUMENT_BUCKET || "").trim();
    const kmsKeyArn = String(process.env.S3_DOCUMENT_KMS_KEY_ARN || "").trim();
    return region && bucket && kmsKeyArn && !process.env.FIELD_EVIDENCE_LOCAL_DIR ? { region, bucket, kmsKeyArn } : null;
  }

  private localPath(objectKey: string): string {
    const configured = String(process.env.FIELD_EVIDENCE_LOCAL_DIR || "").trim();
    if (!configured && process.env.NODE_ENV === "production") throw new ServiceUnavailableException("Evidence storage is not configured.");
    const root = resolve(configured || join(process.cwd(), ".data", "field-evidence"));
    const path = resolve(root, objectKey);
    if (!path.startsWith(`${root}/`)) throw new ServiceUnavailableException("Evidence storage is not configured.");
    return path;
  }

  private s3(region: string): S3Client {
    this.client ||= new S3Client({ region });
    return this.client;
  }
}
