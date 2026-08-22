const mockBaseUrl = process.env.MOCK_PROVIDER_URL || "http://localhost:4001";
const apiBaseUrl = process.env.VERIFICATION_API_URL || "http://localhost:3000";

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { response, body };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const mockHealth = await request(`${mockBaseUrl}/health`);
  assert(mockHealth.response.ok, `Mock health failed: ${JSON.stringify(mockHealth.body)}`);

  const payload = {
    licenseNumber: "KA0120230000000",
    name: "Example User",
    dob: "1995-01-01"
  };

  const success = await request(`${mockBaseUrl}/v1/verify/driving-license`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert(success.response.status === 200, "Success scenario did not return 200");
  assert((success.body as any).status === "verified", "Expected verified provider result");

  const failed = await request(`${mockBaseUrl}/v1/verify/driving-license`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Mock-Scenario": "verification_failed" },
    body: JSON.stringify(payload)
  });
  assert(failed.response.status === 200, "Business verification failure should return HTTP 200");
  assert((failed.body as any).status === "failed", "Expected failed provider result");

  const rateLimited = await request(`${mockBaseUrl}/v1/verify/driving-license`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Mock-Scenario": "http_429" },
    body: JSON.stringify(payload)
  });
  assert(rateLimited.response.status === 429, "Rate-limit scenario did not return 429");

  const application = await request(`${apiBaseUrl}/applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      personal: {
        phone: "9876543210",
        nameAsAadhaar: "Example User",
        dateOfBirth: "1995-01-01",
        aadhaarReference: "1234",
        drivingLicenceNumber: "KA0120230000000"
      },
      education: { highestQualification: "12th pass", courseName: "General" },
      documents: { aadhaarFront: "sandbox://aadhaar-front", drivingLicence: "sandbox://driving-license" }
    })
  });
  assert(application.response.status === 201, `Application creation failed: ${JSON.stringify(application.body)}`);
  assert(Boolean((application.body as any).id), "Application ID missing");

  console.log("Smoke tests passed");
  console.log(JSON.stringify({ mockHealth: mockHealth.body, application: application.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
