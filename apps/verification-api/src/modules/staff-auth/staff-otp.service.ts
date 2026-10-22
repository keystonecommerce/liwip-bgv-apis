import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { adminHmac, hashIp } from "../admin-access/admin-config";
import { EMAIL_SENDER, EmailSender, otpEmail } from "./email-sender";

const EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const SENDS_PER_MINUTE = 2;
const SENDS_PER_HOUR = 10;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function normaliseEmail(input: unknown): string {
  const email = String(input ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new BadRequestException("Enter a valid email address");
  return email;
}

/**
 * Admin sign-in codes by email, ported from Keystone Main Backend: six digits, only an
 * HMAC (keyed by ADMIN_AUTH_SECRET and bound to the email) is stored, five attempts per
 * code, the newest code wins, and sends are throttled per address. The response is the
 * same whether or not an account exists, so the endpoint does not reveal accounts.
 */
@Injectable()
export class StaffOtpService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender
  ) {}

  async send(input: unknown, ip?: string) {
    const email = normaliseEmail(input);
    const now = Date.now();
    const [lastMinute, lastHour] = await Promise.all([
      this.prisma.staffOtp.count({ where: { email, createdAt: { gte: new Date(now - 60_000) } } }),
      this.prisma.staffOtp.count({ where: { email, createdAt: { gte: new Date(now - 3_600_000) } } })
    ]);
    if (lastHour >= SENDS_PER_HOUR) {
      throw new HttpException("Too many codes requested for this email. Try again in an hour.", HttpStatus.TOO_MANY_REQUESTS);
    }
    if (lastMinute >= SENDS_PER_MINUTE) {
      throw new HttpException("Too many codes requested. Wait a minute and try again.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.prisma.portalUser.findUnique({ where: { email }, select: { id: true, status: true } });
    if (user?.status === "ACTIVE") {
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const row = await this.prisma.staffOtp.create({
        data: { id: `staff_otp_${randomUUID()}`, email, codeHash: this.digest(email, code), expiresAt: new Date(now + EXPIRY_MINUTES * 60_000), ipHash: hashIp(ip) }
      });
      try {
        await this.email.send(otpEmail(email, code, EXPIRY_MINUTES));
      } catch (error) {
        await this.prisma.staffOtp.deleteMany({ where: { id: row.id } });
        throw error;
      }
    }
    return { sent: true, expiresInSeconds: EXPIRY_MINUTES * 60, userId: user?.status === "ACTIVE" ? user.id : null };
  }

  /** The account the code was sent to, once; null when the code is wrong, used or expired. */
  async verify(input: unknown, codeInput: unknown) {
    const email = normaliseEmail(input);
    const code = String(codeInput ?? "").trim();
    if (!/^\d{6}$/.test(code)) throw new BadRequestException("Enter the six-digit code");
    const otp = await this.prisma.staffOtp.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" }
    });
    if (!otp || otp.attempts >= MAX_ATTEMPTS) throw this.rejected();
    const supplied = Buffer.from(this.digest(email, code));
    const stored = Buffer.from(otp.codeHash);
    if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) {
      await this.prisma.staffOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { attempts: { increment: 1 } } });
      throw this.rejected();
    }
    // Conditional update: two concurrent requests with the same code cannot both succeed.
    const consumed = await this.prisma.staffOtp.updateMany({
      where: { id: otp.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      data: { consumedAt: new Date(), attempts: { increment: 1 } }
    });
    if (consumed.count !== 1) throw this.rejected();
    const user = await this.prisma.portalUser.findUnique({ where: { email } });
    if (!user || user.status !== "ACTIVE") throw this.rejected();
    return user;
  }

  private digest(email: string, code: string) {
    return adminHmac("staff-otp", `${email}\0${code}`);
  }

  private rejected() {
    return new UnauthorizedException("The code is incorrect or has expired");
  }
}
