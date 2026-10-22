import { Logger, ServiceUnavailableException } from "@nestjs/common";

/** Sends one verification link to one person. `token` is the link's last part, for a URL button. */
export interface InviteMessage { phone: string; name: string; partnerName: string; link: string; token: string }
export interface InviteDelivery { channel: "WHATSAPP" | "SMS" | "LOG"; messageId: string | null; status: "SENT" | "FAILED" }
export interface InviteSender { send(message: InviteMessage): Promise<InviteDelivery> }
export const INVITE_SENDER = Symbol("INVITE_SENDER");

/**
 * The WhatsApp stand-in: logs the link instead of sending it. Used in development, and on staging
 * with INVITE_SENDER=log until the AiSensy template is approved. A production server with no
 * sender chosen refuses rather than silently dropping links.
 */
export class LogInviteSender implements InviteSender {
  private readonly logger = new Logger("InviteSender");
  constructor(private readonly chosen = false) {}
  async send(message: InviteMessage): Promise<InviteDelivery> {
    if (!this.chosen && process.env.NODE_ENV === "production") throw new ServiceUnavailableException("Verification links cannot be sent yet: no WhatsApp sender is configured");
    this.logger.log(`Invite for ******${message.phone.slice(-4)} from ${message.partnerName}: ${message.link}`);
    return { channel: "LOG", messageId: null, status: "SENT" };
  }
}

/**
 * WhatsApp through an AiSensy API campaign, as the main Keystone backend sends its messages.
 * The approved template takes {{1}} the person's name and {{2}} the company's name, and has one
 * URL button whose dynamic suffix is the invite token (button URL: INVITE_LINK_BASE/v/{{1}}).
 */
export class AiSensyInviteSender implements InviteSender {
  constructor(private readonly config: { apiKey: string; campaignName: string; endpoint: string; source: string }) {}

  async send(message: InviteMessage): Promise<InviteDelivery> {
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        apiKey: this.config.apiKey,
        campaignName: this.config.campaignName,
        destination: message.phone,
        userName: message.name.slice(0, 60),
        source: this.config.source,
        templateParams: [message.name.slice(0, 60), message.partnerName.slice(0, 60)],
        buttons: [{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: message.token }] }]
      })
    });
    const text = await response.text().catch(() => "");
    let body: { success?: unknown; submitted_message_id?: unknown; messageId?: unknown } = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!response.ok || body.success === false || body.success === "false") {
      // The request body holds the API key; only AiSensy's reply is reported, cut short.
      throw new Error(`AiSensy refused the invite: ${response.status} ${text.slice(0, 200)}`);
    }
    const messageId = body.submitted_message_id ?? body.messageId;
    return { channel: "WHATSAPP", messageId: typeof messageId === "string" ? messageId : null, status: "SENT" };
  }
}

/** INVITE_SENDER=aisensy sends real WhatsApp messages; =log logs them anywhere; unset logs, and refuses in production. */
export function inviteSenderFromEnv(): InviteSender {
  if (process.env.INVITE_SENDER === "log") return new LogInviteSender(true);
  if (process.env.INVITE_SENDER !== "aisensy") return new LogInviteSender();
  const apiKey = process.env.AISENSY_API_KEY, campaignName = process.env.AISENSY_INVITE_CAMPAIGN_NAME;
  if (!apiKey || !campaignName) throw new Error("INVITE_SENDER=aisensy needs AISENSY_API_KEY and AISENSY_INVITE_CAMPAIGN_NAME");
  return new AiSensyInviteSender({
    apiKey, campaignName,
    endpoint: process.env.AISENSY_ENDPOINT || "https://backend.aisensy.com/campaign/t1/api/v2",
    source: process.env.AISENSY_SOURCE || "Liwip_BGV_Invites"
  });
}
