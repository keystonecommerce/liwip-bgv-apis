export type MockScenario =
  | "success"
  | "verification_failed"
  | "pending"
  | "manual_review"
  | "http_400"
  | "http_401"
  | "http_429"
  | "http_500"
  | "timeout"
  | "malformed_response";

export interface ProviderPayload {
  [key: string]: unknown;
}
