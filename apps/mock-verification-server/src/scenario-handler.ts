import { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { MockScenario, ProviderPayload } from "./types";

const supportedScenarios = new Set<MockScenario>([
  "success", "verification_failed", "pending", "manual_review",
  "http_400", "http_401", "http_429", "http_500", "timeout", "malformed_response"
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function respondWithScenario(
  req: Request,
  res: Response,
  verifiedData: ProviderPayload
): Promise<Response> {
  const requested = String(req.header("X-Mock-Scenario") || "success").toLowerCase() as MockScenario;
  const scenario = supportedScenarios.has(requested) ? requested : "success";
  const delayMs = Number(req.header("X-Mock-Delay-Ms") || 0);

  if (scenario === "timeout") await delay(30_000);
  if (delayMs > 0) await delay(delayMs);

  if (scenario === "http_400") return res.status(400).json({ error: "INVALID_REQUEST", message: "Mock validation error" });
  if (scenario === "http_401") return res.status(401).json({ error: "UNAUTHORIZED", message: "Mock authentication failure" });
  if (scenario === "http_429") return res.status(429).json({ error: "RATE_LIMITED", message: "Mock provider rate limit" });
  if (scenario === "http_500") return res.status(500).json({ error: "PROVIDER_ERROR", message: "Mock provider internal error" });
  if (scenario === "malformed_response") return res.status(200).json({ unexpected: "invalid provider response" });

  if (scenario === "verification_failed") {
    return res.status(200).json({
      requestId: `mock_${uuid()}`,
      status: "failed",
      data: { ...verifiedData, nameMatch: false, documentValid: false }
    });
  }

  if (scenario === "pending") return res.status(202).json({ requestId: `mock_${uuid()}`, status: "pending", data: null });

  if (scenario === "manual_review") {
    return res.status(200).json({
      requestId: `mock_${uuid()}`,
      status: "manual_review",
      data: { ...verifiedData, reviewReason: "Mock review required" }
    });
  }

  return res.status(200).json({ requestId: `mock_${uuid()}`, status: "verified", data: verifiedData });
}
