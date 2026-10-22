import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Webhook URLs must be HTTPS on a public address, so a partner cannot point us at our own
 * network. WEBHOOK_INSECURE_HOSTS lists hosts exempt from both rules (tests and local receivers).
 */
const insecureHosts = () => String(process.env.WEBHOOK_INSECURE_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);

function privateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Checks the URL's form. Used when an endpoint is saved. */
export function webhookUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new BadRequestException("url must be a full https:// address");
  }
  if (url.username || url.password) throw new BadRequestException("url must not carry a username or password");
  if (!insecureHosts().includes(url.hostname.toLowerCase())) {
    if (url.protocol !== "https:") throw new BadRequestException("url must use https");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || (isIP(host) && privateAddress(host))) throw new BadRequestException("url must be a public address");
  }
  if (url.href.length > 500) throw new BadRequestException("url must be 500 characters or fewer");
  url.hash = "";
  return url.href;
}

/** Checks where the URL resolves to right before a delivery. Throws with a short reason. */
export async function assertDeliverable(href: string): Promise<void> {
  const url = new URL(href);
  if (insecureHosts().includes(url.hostname.toLowerCase())) return;
  if (url.protocol !== "https:") throw new Error("not https");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error("resolves to a private address");
}
