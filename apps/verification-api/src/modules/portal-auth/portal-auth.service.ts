import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { verifyPortalPassword } from "./password";

export const portalRoles = ["CORPORATE_ADMIN", "CORPORATE_OPERATOR", "LIWIP_SUPPORT", "FIELD_AGENT"] as const;
export type PortalRole = typeof portalRoles[number];

export interface PortalUserContext {
  userId: string;
  role: PortalRole;
  tenantId?: string;
  clientId?: string;
  email: string;
  displayName: string;
}

type PortalToken = {
  sub: string;
  role: PortalRole;
  tenantId?: string;
  clientId?: string;
  exp: number;
};

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

@Injectable()
export class PortalAuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async login(input: { email?: string; password?: string; role?: string }) {
    const email = String(input.email || "").trim().toLowerCase();
    const password = String(input.password || "");
    if (!email || !password) throw new UnauthorizedException("Email and password are required");

    const user = await this.prisma.portalUser.findUnique({ where: { email } });
    const valid = Boolean(user && user.status === "ACTIVE" && await verifyPortalPassword(password, user.passwordHash));
    if (!user || !valid) throw new UnauthorizedException("Email or password is incorrect");
    if (!portalRoles.includes(user.role as PortalRole)) throw new UnauthorizedException("This account has an unsupported portal role");
    if (input.role && input.role !== user.role) throw new UnauthorizedException("This account does not have access to the selected portal");

    await this.prisma.portalUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = this.createToken({
      sub: user.id,
      role: user.role as PortalRole,
      ...(user.tenantId ? { tenantId: user.tenantId } : {}),
      ...(user.clientId ? { clientId: user.clientId } : {})
    });

    return {
      accessToken: token,
      expiresInSeconds: this.tokenExpirySeconds,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        tenantId: user.tenantId,
        clientId: user.clientId
      }
    };
  }

  async me(authorization?: string) {
    const context = await this.authenticate(authorization);
    return {
      id: context.userId,
      email: context.email,
      displayName: context.displayName,
      role: context.role,
      tenantId: context.tenantId ?? null,
      clientId: context.clientId ?? null
    };
  }

  // Verify a portal Bearer token and confirm the user is still active. Shared by `me`
  // and by PortalAuthGuard so any portal route can authenticate the same way.
  async authenticate(authorization?: string): Promise<PortalUserContext> {
    const token = this.readToken(authorization);
    const user = await this.prisma.portalUser.findUnique({ where: { id: token.sub } });
    if (!user || user.status !== "ACTIVE") throw new UnauthorizedException("Session is no longer active");
    if (!portalRoles.includes(user.role as PortalRole)) throw new UnauthorizedException("This account has an unsupported portal role");
    return {
      userId: user.id,
      role: user.role as PortalRole,
      tenantId: user.tenantId ?? undefined,
      clientId: user.clientId ?? undefined,
      email: user.email,
      displayName: user.displayName
    };
  }

  private get tokenExpirySeconds(): number {
    const configured = Number(process.env.PORTAL_AUTH_TOKEN_EXPIRY_SECONDS || 28800);
    return Number.isFinite(configured) && configured >= 900 && configured <= 86400 ? configured : 28800;
  }

  private get secret(): string {
    const secret = process.env.PORTAL_AUTH_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      throw new ServiceUnavailableException("Portal authentication is not configured");
    }
    return secret;
  }

  private createToken(subject: Omit<PortalToken, "exp">): string {
    const payload: PortalToken = { ...subject, exp: Math.floor(Date.now() / 1000) + this.tokenExpirySeconds };
    const encoded = base64Url(JSON.stringify(payload));
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private readToken(authorization?: string): PortalToken {
    const value = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const [encoded, signature] = value.split(".");
    if (!encoded || !signature) throw new UnauthorizedException("Bearer token is required");
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) {
      throw new UnauthorizedException("Session token is invalid");
    }

    try {
      const token = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PortalToken;
      if (!portalRoles.includes(token.role) || !token.sub || token.exp <= Math.floor(Date.now() / 1000)) {
        throw new UnauthorizedException("Session token has expired");
      }
      return token;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("Session token is invalid");
    }
  }
}
