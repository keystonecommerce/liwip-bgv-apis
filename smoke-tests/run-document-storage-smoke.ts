import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apiBaseUrl = process.env.VERIFICATION_API_URL || "http://localhost:3001";
const firstApiKey = process.env.DEV_PLATFORM_API_KEY || "dev-gig-platform-key-change-me";
const secondApiKey = process.env.DEV_SECOND_PLATFORM_API_KEY || "dev-partner-platform-key-change-me";

async function request(path: string, apiKey: string, init?: RequestInit) {
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
  assert(application, "A seeded Keystone application is required for the document smoke test");

  let documentId: string | undefined;
  try {
    const invalid = await request(`/v1/applications/${application.id}/documents/upload-url`, firstApiKey, {
      method: "POST",
      body: JSON.stringify({
        document_type: "PAN",
        file_name: "test.exe",
        content_type: "application/x-msdownload",
        size_bytes: 128
      })
    });
    assert(invalid.response.status === 400, `Invalid content type must return 400, got ${invalid.response.status}`);

    const created = await request(`/v1/applications/${application.id}/documents/upload-url`, firstApiKey, {
      method: "POST",
      body: JSON.stringify({
        document_type: "PAN",
        file_name: "document-storage-smoke.pdf",
        content_type: "application/pdf",
        size_bytes: 128
      })
    });
    assert(created.response.ok, `Upload URL creation failed: ${JSON.stringify(created.body)}`);
    const payload = created.body as {
      document?: { id?: string; status?: string };
      upload?: { method?: string; url?: string };
    };
    documentId = payload.document?.id;
    assert(documentId, "Upload URL response did not include a document ID");
    assert(payload.document?.status === "PENDING_UPLOAD", "New document must be PENDING_UPLOAD");
    assert(payload.upload?.method === "PUT" && payload.upload.url, "Upload URL response is incomplete");
    const uploadHost = new URL(payload.upload.url).host;

    const list = await request(`/v1/applications/${application.id}/documents`, firstApiKey);
    assert(list.response.ok, `Document list failed: ${JSON.stringify(list.body)}`);
    assert(Array.isArray(list.body) && list.body.some((item: { id?: string }) => item.id === documentId), "Document list did not include the created metadata record");

    const crossTenant = await request(`/v1/applications/${application.id}/documents`, secondApiKey);
    assert(crossTenant.response.status === 404, `Cross-tenant document list must return 404, got ${crossTenant.response.status}`);

    const confirmBeforeUpload = await request(`/v1/applications/${application.id}/documents/${documentId}/complete`, firstApiKey, {
      method: "POST",
      body: "{}"
    });
    assert(confirmBeforeUpload.response.status === 400, `Confirmation before upload must return 400, got ${confirmBeforeUpload.response.status}: ${JSON.stringify(confirmBeforeUpload.body)}`);

    console.log("Document storage smoke tests passed");
    console.log(JSON.stringify({
      validationStatus: invalid.response.status,
      uploadUrlCreated: true,
      uploadMethod: payload.upload.method,
      uploadHost,
      documentStatus: payload.document.status,
      crossTenantStatus: crossTenant.response.status,
      confirmBeforeUploadStatus: confirmBeforeUpload.response.status,
      s3ObjectWritten: false
    }, null, 2));
  } finally {
    if (documentId) {
      await prisma.applicationDocument.deleteMany({
        where: { id: documentId, status: "PENDING_UPLOAD" }
      });
    }
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
