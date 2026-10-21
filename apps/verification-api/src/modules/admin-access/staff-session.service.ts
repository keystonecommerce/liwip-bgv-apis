import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { PrismaService } from "../../common/database/prisma.service";
import { adminHmac, adminOrigins, cookieSettings, firstHeader, hashIp, readCookie, sha256 } from "./admin-config";

export type AuthMethod = "otp" | "passkey";

export interface SessionRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

export interface AuthenticatedSession {
  id: string;
  authMethod: string;
  createdAt: Date;
  user: { id: string; email: string; displayName: string };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SEEN_EVERY_MS = 5 * 60_000;

/**
 * Admin panel sessions: a random token in an httpOnly cookie, only its hash stored.
 * A session is valid while unexpired, not revoked and issued at the account's current
 * sessionVersion, so bumping sessionVersion revokes every session at once.
 *
 * CSRF: every state-changing request must echo the session's CSRF token in X-CSRF-Token.
 * The token is returned in the sign-in and session responses (readable only by allowed
 * origins under CORS) and is an HMAC of the session id, so nothing extra is stored.
 */
@Injectable()
export class StaffSessionService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async start(user: { id: string; sessionVersion: number }, method: AuthMethod, request: SessionRequest, response: Response) {
    const settings = cookieSettings();
    const token = randomBytes(32).toString("base64url");
    const session = await this.prisma.staffSession.create({
      data: {
        id: `staff_session_${randomUUID()}`,
        userId: user.id,
        tokenHash: sha256(token),
        sessionVersion: user.sessionVersion,
        authMethod: method,
        ipHash: hashIp(request.ip),
        userAgent: firstHeader(request.headers["user-agent"])?.slice(0, 300) ?? null,
        expiresAt: new Date(Date.now() + settings.maxAgeMs)
      }
    });
    await this.prisma.portalUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    response.cookie(settings.name, token, { httpOnly: true, secure: settings.secure, sameSite: "lax", path: "/", maxAge: settings.maxAgeMs });
    return { sessionId: session.id, csrfToken: this.csrfToken(session.id), expiresAt: session.expiresAt.toISOString() };
  }

  async authenticate(request: SessionRequest): Promise<AuthenticatedSession> {
    const token = readCookie(request.headers.cookie, cookieSettings().name);
    if (!token || token.length > 100) throw new UnauthorizedException("Sign in to continue");
    const session = await this.prisma.staffSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { id: true, email: true, displayName: true, status: true, sessionVersion: true } } }
    });
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now || session.user.status !== "ACTIVE" || session.sessionVersion !== session.user.sessionVersion) {
      throw new UnauthorizedException("Your session has ended. Sign in again.");
    }
    if (now - session.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      void this.prisma.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
    }
    const { status: _status, sessionVersion: _version, ...user } = session.user;
    return { id: session.id, authMethod: session.authMethod, createdAt: session.createdAt, user };
  }

  csrfToken(sessionId: string): string {
    return adminHmac("csrf", sessionId);
  }

  /** Refuses state-changing requests without the session's CSRF token or from an origin that is not the admin panel. */
  assertCsrf(request: SessionRequest & { method: string }, sessionId: string | null): void {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return;
    const origin = firstHeader(request.headers.origin);
    const allowed = adminOrigins();
    if (origin && allowed.length && !allowed.includes(origin.replace(/\/+$/, ""))) throw new ForbiddenException("Request origin is not allowed");
    if (sessionId === null) return; // sign-in requests: no session yet, origin checked above
    const supplied = Buffer.from(firstHeader(request.headers["x-csrf-token"]) || "");
    const expected = Buffer.from(this.csrfToken(sessionId));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ForbiddenException("Missing or invalid CSRF token");
  }

  async end(sessionId: string, response: Response) {
    await this.prisma.staffSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    this.clearCookie(response);
  }

  /** Signs the account out everywhere. */
  async revokeAll(userId: string) {
    await this.prisma.$transaction([
      this.prisma.portalUser.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } }),
      this.prisma.staffSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
    ]);
  }

  clearCookie(response: Response) {
    const settings = cookieSettings();
    response.clearCookie(settings.name, { httpOnly: true, secure: settings.secure, sameSite: "lax", path: "/" });
  }
}
