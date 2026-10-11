import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { Injectable, Logger } from "@nestjs/common";

/**
 * Turns the text of a DigiLocker document into fields, with Claude on Amazon Bedrock.
 * The model is a setting (`BEDROCK_EXTRACT_MODEL`) so it can change without touching the
 * flow. The default is Haiku 4.5 on the India-only route (Mumbai and Hyderabad), so text
 * stays in India. Only already-trimmed text is sent (no address, no father's name).
 */
export type ExtractableDocument = "DRVLC" | "RVCER" | "PANCR";

export interface ExtractedFields {
  number: string | null;
  name: string | null;
  dateOfBirth: string | null;
  dateOfExpiry: string | null;
}

const DEFAULT_MODEL = "in.anthropic.claude-haiku-4-5-20251001-v1:0";

const WHAT: Record<ExtractableDocument, { title: string; number: string; name: string }> = {
  DRVLC: { title: "an Indian driving licence", number: "the driving licence number", name: "the licence holder's name" },
  RVCER: { title: "an Indian vehicle registration certificate", number: "the vehicle registration number", name: "the registered owner's name" },
  PANCR: { title: "an Indian PAN verification record", number: "the 10-character PAN", name: "the PAN holder's name" }
};

@Injectable()
export class DocumentExtractor {
  private readonly logger = new Logger(DocumentExtractor.name);
  private readonly client = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || "ap-south-1" });
  private readonly model = process.env.BEDROCK_EXTRACT_MODEL || DEFAULT_MODEL;

  /** Fields from the document text, or null when the model call fails or answers badly. */
  async extract(doctype: ExtractableDocument, text: string): Promise<ExtractedFields | null> {
    const what = WHAT[doctype];
    const prompt = [
      `The text below is from ${what.title}, issued through DigiLocker.`,
      `Reply with only a JSON object: {"number": ${what.number}, "name": ${what.name}, "date_of_birth": "YYYY-MM-DD", "date_of_expiry": "YYYY-MM-DD"}.`,
      "Copy the number exactly as written, without spaces. Use null for anything not in the text. Do not guess.",
      "",
      "<document>",
      text.slice(0, 6000),
      "</document>"
    ].join("\n");
    const started = Date.now();
    try {
      const response = await this.client.send(new ConverseCommand({
        modelId: this.model,
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0 }
      }), { abortSignal: AbortSignal.timeout(15_000) });
      const reply = response.output?.message?.content?.find((part) => "text" in part)?.text ?? "";
      const json = /\{[\s\S]*\}/.exec(reply)?.[0];
      if (!json) return null;
      const raw = JSON.parse(json) as Record<string, unknown>;
      const value = (key: string) => (typeof raw[key] === "string" && String(raw[key]).trim() ? String(raw[key]).trim() : null);
      this.logger.log(`Extracted ${doctype} fields in ${Date.now() - started} ms`);
      return {
        number: value("number")?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
        name: value("name"),
        dateOfBirth: value("date_of_birth"),
        dateOfExpiry: value("date_of_expiry")
      };
    } catch (error) {
      // Never log document text; the error message is enough.
      this.logger.warn(`Extraction failed for ${doctype}: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
  }
}
