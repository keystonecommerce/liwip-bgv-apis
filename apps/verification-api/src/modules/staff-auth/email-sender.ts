import { Logger, ServiceUnavailableException } from "@nestjs/common";

export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

/** otp: a sign-in code. invite: an account was created for you. */
export type EmailKind = "otp" | "invite";

export interface EmailMessage {
  kind: EmailKind;
  to: string;
  subject: string;
  /** Plain-text body, also used by the development logger. */
  text: string;
  /** Template variables for providers that render their own templates. */
  variables: Record<string, string>;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Local development: prints the email (and so the code) to the server log. Never in production. */
export class DevLogEmailSender implements EmailSender {
  private readonly logger = new Logger("DevLogEmailSender");
  async send(message: EmailMessage): Promise<void> {
    if (process.env.NODE_ENV === "production") throw new ServiceUnavailableException("Email is not configured");
    this.logger.warn(`[DEV EMAIL] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

/** Production without an email provider: refuse rather than silently drop sign-in codes. */
export class UnconfiguredEmailSender implements EmailSender {
  async send(): Promise<void> {
    throw new ServiceUnavailableException("Email is not configured");
  }
}

/**
 * MSG91 Email (the provider this API already uses for SMS OTP). Each kind uses its own
 * approved template; variables are passed through.
 * MSG91_AUTHKEY, MSG91_EMAIL_DOMAIN, MSG91_EMAIL_FROM, MSG91_EMAIL_OTP_TEMPLATE_ID, MSG91_EMAIL_INVITE_TEMPLATE_ID.
 */
export class Msg91EmailSender implements EmailSender {
  private readonly logger = new Logger("Msg91EmailSender");

  async send(message: EmailMessage): Promise<void> {
    const authKey = (process.env.MSG91_AUTHKEY || process.env.MSG91_AUTH_KEY || "").trim();
    const domain = (process.env.MSG91_EMAIL_DOMAIN || "").trim();
    const from = (process.env.MSG91_EMAIL_FROM || "").trim();
    const templateId = (message.kind === "otp" ? process.env.MSG91_EMAIL_OTP_TEMPLATE_ID : process.env.MSG91_EMAIL_INVITE_TEMPLATE_ID)?.trim();
    if (!authKey || !domain || !from || !templateId) throw new ServiceUnavailableException("Email is not configured");
    let response: Response;
    try {
      response = await fetch(process.env.MSG91_EMAIL_ENDPOINT?.trim() || "https://control.msg91.com/api/v5/email/send", {
        method: "POST",
        headers: { accept: "application/json", authkey: authKey, "content-type": "application/json" },
        body: JSON.stringify({
          recipients: [{ to: [{ email: message.to }], variables: message.variables }],
          from: { email: from, name: process.env.MSG91_EMAIL_FROM_NAME?.trim() || "Liwip BGV" },
          domain,
          template_id: templateId
        }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new ServiceUnavailableException("Email could not be sent. Try again.");
    }
    if (!response.ok) {
      this.logger.warn(`MSG91 email rejected status=${response.status} kind=${message.kind}`);
      throw new ServiceUnavailableException("Email could not be sent. Try again.");
    }
  }
}

export function emailSenderFromEnv(): EmailSender {
  if (process.env.MSG91_EMAIL_DOMAIN?.trim()) return new Msg91EmailSender();
  return process.env.NODE_ENV === "production" ? new UnconfiguredEmailSender() : new DevLogEmailSender();
}

export function otpEmail(to: string, code: string, minutes: number): EmailMessage {
  return {
    kind: "otp",
    to,
    subject: `${code} is your Liwip BGV admin sign-in code`,
    text: `Your Liwip BGV admin sign-in code is ${code}. It expires in ${minutes} minutes. If you did not try to sign in, ignore this email.`,
    variables: { code, minutes: String(minutes) }
  };
}

/** `url` is the app this person signs in to: the control panel (Keystone) or the business portal. */
export function inviteEmail(to: string, name: string, organisation: string, url: string): EmailMessage {
  return {
    kind: "invite",
    to,
    subject: "You have been added to Liwip BGV",
    text: `Hello ${name}, you now have access to ${organisation} on Liwip BGV. Sign in at ${url} with this email address; we will email you a code.`,
    variables: { name, organisation, url }
  };
}
