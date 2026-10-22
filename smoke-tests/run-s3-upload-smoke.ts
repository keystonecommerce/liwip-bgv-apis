import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();
const apiBaseUrl = process.env.VERIFICATION_API_URL || "http://localhost:4310";
const apiKey = process.env.DEV_PLATFORM_API_KEY || "dev-gig-platform-key-change-me";

const pdf = Buffer.from([
  "%PDF-1.4",
  "% LIWIP BGV secure document storage smoke test",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Count 0 >>",
  "endobj",
  "trailer",
  "<< /Root 1 0 R >>",
  "%%EOF",
  ""
].join("\n"), "utf8");

async function apiRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "X-API-Key": apiKey,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep non-JSON response */ }
  return { response, body };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const application = await prisma.application.findFirst({
    where: { tenantId: "tenant_keystone", clientId: "client_keystone_worker_portal" },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  assert(application, "A seeded Keystone application is required for the S3 upload smoke test");

  const createResponse = await apiRequest(`/v1/applications/${application.id}/documents/upload-url`, {
    method: "POST",
    body: JSON.stringify({
      document_type: "OTHER",
      file_name: "s3-document-smoke-test.pdf",
      content_type: "application/pdf",
      size_bytes: pdf.byteLength
    })
  });
  assert(createResponse.response.ok, `Could not create upload URL: ${JSON.stringify(createResponse.body)}`);

  const created = createResponse.body as {
    document?: { id?: string; status?: string };
    upload?: { method?: string; url?: string; headers?: Record<string, string> };
  };
  const documentId = created.document?.id;
  const uploadUrl = created.upload?.url;
  assert(documentId && uploadUrl && created.upload?.headers, "Upload URL response is incomplete");

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: created.upload.headers,
    body: pdf
  });
  const uploadError = uploadResponse.ok ? "" : await uploadResponse.text();
  assert(uploadResponse.ok, `S3 PUT failed with ${uploadResponse.status}: ${uploadError}`);

  const confirmResponse = await apiRequest(`/v1/applications/${application.id}/documents/${documentId}/complete`, {
    method: "POST",
    body: "{}"
  });
  assert(confirmResponse.response.ok, `Upload confirmation failed: ${JSON.stringify(confirmResponse.body)}`);
  const confirmed = confirmResponse.body as { document?: { status?: string; size_bytes?: number } };
  assert(confirmed.document?.status === "UPLOADED", "Confirmed document did not become UPLOADED");
  assert(confirmed.document.size_bytes === pdf.byteLength, "Confirmed document size does not match the upload");

  const downloadResponse = await apiRequest(`/v1/applications/${application.id}/documents/${documentId}/download-url`);
  assert(downloadResponse.response.ok, `Could not create download URL: ${JSON.stringify(downloadResponse.body)}`);
  const download = downloadResponse.body as { url?: string };
  assert(download.url, "Download URL response is incomplete");

  const objectResponse = await fetch(download.url);
  assert(objectResponse.ok, `S3 GET failed with ${objectResponse.status}`);
  const downloaded = Buffer.from(await objectResponse.arrayBuffer());
  const sourceHash = createHash("sha256").update(pdf).digest("hex");
  const downloadedHash = createHash("sha256").update(downloaded).digest("hex");
  assert(sourceHash === downloadedHash, "Downloaded object checksum does not match the uploaded object");

  const stored = await prisma.applicationDocument.findUnique({ where: { id: documentId } });
  assert(stored?.status === "UPLOADED", "PostgreSQL document status is not UPLOADED");
  assert(stored.storageEncryption === "aws:kms", "PostgreSQL did not record SSE-KMS encryption");
  assert(stored.kmsKeyArn, "PostgreSQL did not record the KMS key reference");

  console.log("Real S3 upload smoke test passed");
  console.log(JSON.stringify({
    documentId,
    uploadHost: new URL(uploadUrl).host,
    status: stored.status,
    sizeBytes: stored.sizeBytes,
    encryption: stored.storageEncryption,
    versioned: Boolean(stored.versionId),
    downloadMatchesUpload: true,
    objectDeleted: false
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
