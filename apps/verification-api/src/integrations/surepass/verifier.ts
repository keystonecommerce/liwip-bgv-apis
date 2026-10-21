import type { VerificationType } from "../../domain/verification.types";
import type { RawProviderResponse } from "../verification-provider";
import type { SurepassTransport } from "./surepass.transport";
import type { Verdict } from "./verdicts";

/**
 * One queued check: the Surepass call that runs it and how its response is judged.
 * `payload` is the case data the queue prepares for this type (applicationToPayload).
 */
export interface Verifier {
  type: VerificationType;
  /** Names the check in provider errors. */
  label: string;
  call(transport: SurepassTransport, payload: Record<string, unknown>): Promise<RawProviderResponse>;
  /** Without one, a successful response goes to review. */
  verdict?(payload: Record<string, unknown>): Verdict;
}
