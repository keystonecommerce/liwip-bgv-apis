import "reflect-metadata";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AadhaarMasker } from "../../apps/verification-api/src/modules/document-storage/aadhaar-masker";
import { DocumentStorageService, type StorageConfiguration } from "../../apps/verification-api/src/modules/document-storage/document-storage.service";

const RAW = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
const MASKED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
let server: ReturnType<typeof createServer>, base: string;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/masked.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(MASKED); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUREPASS_MASKED_IMAGE_HOSTS = "127.0.0.1";
  Object.assign(process.env, { AWS_REGION: "ap-south-1", S3_DOCUMENT_BUCKET: "docs", S3_DOCUMENT_KMS_KEY_ARN: "arn:aws:kms:ap-south-1:1:key/test" });
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

const owner = { tenantId: "t", clientId: "c", applicationId: "a", documentId: "doc_1" };
const providerReturning = (outcome: () => Promise<{ data: Record<string, unknown> }>) => ({ executeCheck: async (type: string) => { assert.equal(type, "AADHAAR_MASK"); return outcome(); } });
const masker = (outcome: () => Promise<{ data: Record<string, unknown> }>) => new AadhaarMasker(providerReturning(outcome) as never);

test("the masker fetches Surepass's masked image and checks what it is", async () => {
  const result = await masker(async () => ({ data: { masked_image: `${base}/masked.png` } })).mask({ buffer: RAW, originalname: "a.jpg", mimetype: "image/jpeg" }, owner);
  assert.equal(result.contentType, "image/png");
  assert.ok(result.bytes.equals(MASKED));
});

test("the masker refuses links outside Surepass's hosts and reports what failed", async () => {
  await assert.rejects(masker(async () => ({ data: { masked_image: "https://evil.example/masked.png" } })).mask({ buffer: RAW, originalname: "a.jpg", mimetype: "image/jpeg" }, owner), { status: 503 });
  await assert.rejects(masker(async () => ({ data: {} })).mask({ buffer: RAW, originalname: "a.jpg", mimetype: "image/jpeg" }, owner), { status: 503 });
  await assert.rejects(masker(async () => { throw Object.assign(new Error("no"), { code: "PROVIDER_HTTP_ERROR" }); }).mask({ buffer: RAW, originalname: "a.jpg", mimetype: "image/jpeg" }, owner), { status: 422 });
  await assert.rejects(masker(async () => ({ data: { masked_image: `${base}/missing.png` } })).mask({ buffer: RAW, originalname: "a.jpg", mimetype: "image/jpeg" }, owner), { status: 503 });
});

/** Document storage against a fake S3 and database. */
function storage(maskWith: AadhaarMasker, documentType = "AADHAAR") {
  const doc = { id: "doc_1", tenantId: "t", clientId: "c", applicationId: "a", documentType, status: "PENDING_UPLOAD", bucket: "docs", objectKey: "temporary/doc_1", originalFileName: "aadhaar.jpg", contentType: "image/jpeg", declaredSizeBytes: RAW.length, sizeBytes: null, versionId: null, etag: null, checksumSha256: null, storageEncryption: null, kmsKeyArn: null, expiresAt: new Date(), maskedAt: null as Date | null, uploadedAt: null, deletedAt: null as Date | null, createdAt: new Date(), updatedAt: new Date() };
  const s3Calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  const prisma = {
    applicationDocument: {
      findFirst: async () => ({ ...doc }),
      updateMany: async ({ where, data }: { where: { status: string }; data: object }) => { if (doc.status !== where.status) return { count: 0 }; Object.assign(doc, data); return { count: 1 }; },
      update: async ({ data }: { data: object }) => Object.assign(doc, data)
    }
  };
  class FakeS3Storage extends DocumentStorageService {
    protected override s3(_config: StorageConfiguration) {
      return { send: async (command: { input: Record<string, unknown> }) => {
        s3Calls.push({ command: command.constructor.name, input: command.input });
        if (command instanceof HeadObjectCommand) return { ContentLength: RAW.length, ContentType: "image/jpeg", ServerSideEncryption: "aws:kms", SSEKMSKeyId: process.env.S3_DOCUMENT_KMS_KEY_ARN, VersionId: "raw-v1" };
        if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array(RAW) } };
        if (command instanceof PutObjectCommand) return { VersionId: "masked-v1", ETag: '"etag"' };
        if (command instanceof DeleteObjectCommand) return {};
        throw new Error("unexpected command");
      } } as never;
    }
  }
  return { service: new FakeS3Storage(prisma as never, maskWith), doc, s3Calls };
}
const client = { tenantId: "t", clientId: "c" } as never;

test("an Aadhaar upload is kept only masked: the masked copy is stored and the original version deleted", async () => {
  const { service, doc, s3Calls } = storage(masker(async () => ({ data: { masked_image: `${base}/masked.png` } })));
  const { document } = await service.confirmUpload("a", "doc_1", client);
  assert.equal(document.status, "UPLOADED"); assert.equal(document.masked, true); assert.equal(document.content_type, "image/png");
  assert.equal(doc.objectKey, "temporary/doc_1-masked"); assert.ok(doc.maskedAt);
  const put = s3Calls.find((call) => call.command === "PutObjectCommand")!;
  assert.equal(put.input.Key, "temporary/doc_1-masked"); assert.ok((put.input.Body as Buffer).equals(MASKED)); assert.equal(put.input.ServerSideEncryption, "aws:kms");
  assert.deepEqual(s3Calls.filter((call) => call.command === "DeleteObjectCommand").map((call) => call.input), [{ Bucket: "docs", Key: "temporary/doc_1", VersionId: "raw-v1" }]);
});

test("when masking fails the original is deleted and the upload is not kept", async () => {
  const { service, doc, s3Calls } = storage(masker(async () => { throw Object.assign(new Error("no"), { code: "PROVIDER_HTTP_ERROR" }); }));
  await assert.rejects(service.confirmUpload("a", "doc_1", client), { status: 422 });
  assert.equal(doc.status, "DELETED"); assert.equal(doc.maskedAt, null);
  assert.ok(!s3Calls.some((call) => call.command === "PutObjectCommand"));
  assert.deepEqual(s3Calls.filter((call) => call.command === "DeleteObjectCommand").map((call) => call.input.Key), ["temporary/doc_1"]);
});

test("other documents are kept as uploaded, without masking", async () => {
  const { service, doc, s3Calls } = storage(masker(async () => { throw new Error("must not be called"); }), "PAN");
  const { document } = await service.confirmUpload("a", "doc_1", client);
  assert.equal(document.status, "UPLOADED"); assert.equal(document.masked, false); assert.equal(doc.objectKey, "temporary/doc_1");
  assert.deepEqual(s3Calls.map((call) => call.command), ["HeadObjectCommand"]);
});
