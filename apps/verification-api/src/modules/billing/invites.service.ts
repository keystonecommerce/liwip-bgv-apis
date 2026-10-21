import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { billingConfig } from "./billing-config";
import { packageCode } from "./catalog.service";
import { INVITE_SENDER, InviteSender } from "./invite-sender";
import { SeatsService } from "./seats.service";

export type RowStatus = "READY" | "DUPLICATE" | "ALREADY_INVITED" | "INVALID_PHONE" | "INVALID_NAME";
export interface UploadRow { row: number; name: string; phone: string; status: RowStatus }

const MAX_ROWS = 5000;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A mobile as 91XXXXXXXXXX, or null. Accepts +91, 0 and spaces or dashes. */
export function normalisePhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(local) ? `91${local}` : null;
}

const cleanName = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");
const validName = (name: string) => /^[\p{L} .'-]{2,80}$/u.test(name);

/** CSV with a header naming the columns: name, and mobile (or phone). Quotes and commas inside quotes are handled. */
export function parseCsv(text: string): Array<{ name: string; mobile: string }> {
  const records: string[][] = [];
  let field = "", record: string[] = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field); field = "";
      if (record.some((cell) => cell.trim())) records.push(record);
      record = [];
    } else field += char;
  }
  record.push(field);
  if (record.some((cell) => cell.trim())) records.push(record);
  if (!records.length) return [];
  const header = records[0].map((cell) => cell.trim().toLowerCase());
  const nameAt = header.findIndex((cell) => cell === "name" || cell === "full name");
  const mobileAt = header.findIndex((cell) => ["mobile", "phone", "mobile number", "phone number"].includes(cell));
  if (nameAt < 0 || mobileAt < 0) throw new BadRequestException("The first row must name the columns: name, mobile");
  return records.slice(1).map((cells) => ({ name: cells[nameAt] ?? "", mobile: cells[mobileAt] ?? "" }));
}

@Injectable()
export class InvitesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvitesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatsService) private readonly seats: SeatsService,
    @Inject(INVITE_SENDER) private readonly sender: InviteSender
  ) {}

  onModuleInit() {
    if (process.env.BILLING_JOBS === "off") return;
    this.timer = setInterval(() => void this.expire().catch((error) => this.logger.warn(`Invite expiry failed: ${(error as Error).message}`)), 60 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Checks a list of people for one program and package. Nothing is sent yet. */
  async validate(input: { tenantId: string; clientId: string; packageCode: string; fileName: string; csv?: unknown; rows?: unknown; createdById: string }) {
    const code = packageCode(input.packageCode);
    const program = await this.prisma.client.findFirst({ where: { id: input.clientId, tenantId: input.tenantId, status: "ACTIVE" }, select: { id: true } });
    if (!program) throw new NotFoundException("Program not found");
    if (!(await this.prisma.verificationPackage.count({ where: { code, kind: "BASE" } }))) throw new NotFoundException(`${code} is not a package`);
    const raw = typeof input.csv === "string" ? parseCsv(input.csv) : Array.isArray(input.rows) ? (input.rows as Array<{ name?: unknown; mobile?: unknown }>).map((row) => ({ name: String(row?.name ?? ""), mobile: String(row?.mobile ?? "") })) : null;
    if (!raw) throw new BadRequestException("Send csv text or rows of { name, mobile }");
    if (!raw.length) throw new BadRequestException("The file has no people in it");
    if (raw.length > MAX_ROWS) throw new BadRequestException(`Upload at most ${MAX_ROWS} people at a time`);

    const phones = raw.map((row) => normalisePhone(row.mobile));
    const open = new Set((await this.prisma.invite.findMany({ where: { tenantId: input.tenantId, status: { in: ["SENT", "STARTED"] }, phone: { in: phones.filter((phone): phone is string => Boolean(phone)) } }, select: { phone: true } })).map((row) => row.phone));
    const seen = new Set<string>();
    const rows: UploadRow[] = raw.map((row, index) => {
      const name = cleanName(row.name);
      const phone = phones[index];
      const status: RowStatus = !validName(name) ? "INVALID_NAME" : !phone ? "INVALID_PHONE" : seen.has(phone) ? "DUPLICATE" : open.has(phone) ? "ALREADY_INVITED" : "READY";
      if (phone) seen.add(phone);
      return { row: index + 2, name, phone: phone ?? String(row.mobile).trim().slice(0, 20), status };
    });
    const readyCount = rows.filter((row) => row.status === "READY").length;
    const upload = await this.prisma.bulkUpload.create({
      data: {
        id: `upload_${randomUUID()}`, tenantId: input.tenantId, clientId: input.clientId, packageCode: code, fileName: String(input.fileName || "upload.csv").slice(0, 120),
        rowCount: rows.length, readyCount, rejectedCount: rows.length - readyCount, rows: rows as unknown as Prisma.InputJsonValue, createdById: input.createdById
      }
    });
    const balance = (await this.seats.balances(input.tenantId)).find((item) => item.packageCode === code);
    return { ...this.uploadView(upload), seatsAvailable: balance?.available ?? 0 };
  }

  /** Reserves a seat per ready row and sends each person their link. */
  async send(input: { tenantId: string; uploadId: string; partnerName: string; createdById: string }) {
    const created = await this.prisma.$transaction(async (tx) => {
      const upload = await tx.bulkUpload.findFirst({ where: { id: input.uploadId, tenantId: input.tenantId } });
      if (!upload) throw new NotFoundException("Upload not found");
      if (upload.status !== "VALIDATED") throw new ConflictException("These links were already sent");
      const ready = (upload.rows as unknown as UploadRow[]).filter((row) => row.status === "READY");
      if (!ready.length) throw new BadRequestException("No one in this upload is ready to invite");
      await this.seats.lock(tx, input.tenantId, upload.packageCode);
      const invites = ready.map((row) => ({ id: `invite_${randomUUID()}`, token: randomBytes(18).toString("base64url"), row }));
      const versions = await this.seats.reserve(tx, input.tenantId, upload.packageCode, invites.map((invite) => invite.id));
      const expiresAt = new Date(Date.now() + billingConfig().inviteDays * 86_400_000);
      try {
        await tx.invite.createMany({
          data: invites.map((invite, index) => ({
            id: invite.id, tenantId: input.tenantId, clientId: upload.clientId, uploadId: upload.id, packageCode: upload.packageCode, packageVersion: versions[index],
            name: invite.row.name, phone: invite.row.phone, tokenHash: hashToken(invite.token), expiresAt, createdById: input.createdById
          }))
        });
      } catch (error) {
        if ((error as Prisma.PrismaClientKnownRequestError).code === "P2002") throw new ConflictException("Someone in this upload was invited meanwhile. Upload the file again.");
        throw error;
      }
      await tx.bulkUpload.update({ where: { id: upload.id }, data: { status: "SENT", sentAt: new Date() } });
      return invites;
    });
    const results = await this.deliver(created.map((invite) => ({ id: invite.id, token: invite.token, phone: invite.row.phone, name: invite.row.name })), input.partnerName);
    return { sent: results.filter((result) => result === "SENT").length, failed: results.filter((result) => result === "FAILED").length };
  }

  /** A new link for an invite that was not delivered or was lost. The old link stops working. */
  async resend(input: { tenantId: string; inviteId: string; partnerName: string }) {
    const invite = await this.prisma.invite.findFirst({ where: { id: input.inviteId, tenantId: input.tenantId } });
    if (!invite) throw new NotFoundException("Invite not found");
    if (invite.status !== "SENT") throw new ConflictException("Only an unopened link can be resent");
    const token = randomBytes(18).toString("base64url");
    await this.prisma.invite.update({ where: { id: invite.id }, data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + billingConfig().inviteDays * 86_400_000) } });
    const [result] = await this.deliver([{ id: invite.id, token, phone: invite.phone, name: invite.name }], input.partnerName);
    return { status: result };
  }

  private async deliver(invites: Array<{ id: string; token: string; phone: string; name: string }>, partnerName: string) {
    const base = billingConfig().inviteLinkBase;
    const results: Array<"SENT" | "FAILED"> = [];
    for (const invite of invites) {
      let delivery: { channel: string; messageId: string | null; status: "SENT" | "FAILED" };
      try {
        delivery = await this.sender.send({ phone: invite.phone, name: invite.name, partnerName, link: `${base}/v/${invite.token}`, token: invite.token });
      } catch (error) {
        this.logger.warn(`Invite ${invite.id} not sent: ${(error as Error).message}`);
        delivery = { channel: "WHATSAPP", messageId: null, status: "FAILED" };
      }
      await this.prisma.invite.update({ where: { id: invite.id }, data: { channel: delivery.channel, messageId: delivery.messageId, deliveryStatus: delivery.status } });
      results.push(delivery.status);
    }
    return results;
  }

  async cancel(input: { tenantId: string; inviteId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const invite = await tx.invite.findFirst({ where: { id: input.inviteId, tenantId: input.tenantId } });
      if (!invite) throw new NotFoundException("Invite not found");
      if (invite.status !== "SENT") throw new ConflictException("Only an unopened link can be cancelled");
      await this.seats.lock(tx, invite.tenantId, invite.packageCode);
      const flipped = await tx.invite.updateMany({ where: { id: invite.id, status: "SENT" }, data: { status: "CANCELLED" } });
      if (flipped.count) await this.seats.release(tx, invite, "Cancelled");
      return { id: invite.id, status: "CANCELLED" };
    });
  }

  /** Unopened links past their date expire and give their seat back. */
  async expire() {
    const stale = await this.prisma.invite.findMany({ where: { status: "SENT", expiresAt: { lt: new Date() } }, take: 500 });
    for (const invite of stale) {
      await this.prisma.$transaction(async (tx) => {
        await this.seats.lock(tx, invite.tenantId, invite.packageCode);
        const flipped = await tx.invite.updateMany({ where: { id: invite.id, status: "SENT" }, data: { status: "EXPIRED" } });
        if (flipped.count) await this.seats.release(tx, invite, "Link expired");
      });
    }
    return { expired: stale.length };
  }

  async list(tenantId: string | null, query: { status?: string; search?: string; uploadId?: string }, page: { skip: number; limit: number }) {
    const search = String(query.search ?? "").trim();
    const where: Prisma.InviteWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(query.status ? { status: String(query.status).toUpperCase() } : {}),
      ...(query.uploadId ? { uploadId: String(query.uploadId) } : {}),
      ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, ...(/^\d{4,10}$/.test(search) ? [{ phone: { endsWith: search } }] : [])] } : {})
    };
    const [rows, total] = await Promise.all([
      this.prisma.invite.findMany({ where, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.limit }),
      this.prisma.invite.count({ where })
    ]);
    return {
      rows: rows.map((row) => ({ id: row.id, name: row.name, phoneLast4: row.phone.slice(-4), packageCode: row.packageCode, status: row.status, deliveryStatus: row.deliveryStatus, channel: row.channel, expiresAt: row.expiresAt, createdAt: row.createdAt })),
      total
    };
  }

  getUpload(tenantId: string, uploadId: string) {
    return this.prisma.bulkUpload.findFirst({ where: { id: uploadId, tenantId } }).then((upload) => {
      if (!upload) throw new NotFoundException("Upload not found");
      return this.uploadView(upload);
    });
  }

  /** The link's landing: where the Liwip app should take the person. Never says whose link it is. */
  async landing(token: string) {
    const app = billingConfig().workerAppUrl;
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return `${app}/?invite=invalid`;
    const invite = await this.prisma.invite.findUnique({ where: { tokenHash: hashToken(token) }, select: { status: true, expiresAt: true } });
    if (!invite || invite.status === "CANCELLED") return `${app}/?invite=invalid`;
    if (invite.status === "EXPIRED" || invite.expiresAt < new Date()) return `${app}/?invite=expired`;
    return `${app}/?invite=${encodeURIComponent(token)}`;
  }

  private uploadView(upload: Prisma.BulkUploadGetPayload<object>) {
    const rows = upload.rows as unknown as UploadRow[];
    return {
      id: upload.id, packageCode: upload.packageCode, clientId: upload.clientId, fileName: upload.fileName, status: upload.status,
      rowCount: upload.rowCount, readyCount: upload.readyCount, rejectedCount: upload.rejectedCount, createdAt: upload.createdAt, sentAt: upload.sentAt,
      // Valid numbers come back masked; an invalid entry comes back as typed so it can be fixed.
      rows: rows.map((row) => ({ row: row.row, name: row.name, phoneLast4: /^91\d{10}$/.test(row.phone) ? row.phone.slice(-4) : null, entered: /^91\d{10}$/.test(row.phone) ? null : row.phone, status: row.status }))
    };
  }
}
