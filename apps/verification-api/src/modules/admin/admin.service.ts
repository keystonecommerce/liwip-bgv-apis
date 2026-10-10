import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/database/prisma.service";
import { PartnerProvisioning, CreatePartnerInput, IssueKeyInput } from "../../common/security/partner-provisioning";
export type { CreatePartnerInput, IssueKeyInput } from "../../common/security/partner-provisioning";
@Injectable()
export class AdminService {
  private readonly provisioning: PartnerProvisioning;
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { this.provisioning = new PartnerProvisioning(prisma); }
  createPartner(input: CreatePartnerInput) { return this.provisioning.createPartner(input); }
  issueKey(clientId: string, input: IssueKeyInput) { return this.provisioning.issueKey(clientId, input); }
  rotateKey(id: string) { return this.provisioning.rotateKey(id); }
  revokeKey(id: string) { return this.provisioning.revokeKey(id); }
  async listPartners(limit = 50) {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        clients: {
          include: {
            apiKeys: {
              orderBy: { createdAt: "desc" },
              select: { id: true, name: true, keyPrefix: true, scopes: true, isActive: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true },
            },
          },
        },
      },
    });
    return { tenants };
  }

  /**
   * Fresh start for one worker (testing and support). Their cases are archived,
   * not deleted, so provider-call and billing records stay intact; their passkeys
   * are removed. The next sign-in opens a new draft case.
   */
  async resetWorker(input: { phone?: string; clientId?: string }) {
    const national = String(input?.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    if (!/^[6-9]\d{9}$/.test(national)) throw new BadRequestException("phone must be a 10-digit Indian mobile number");
    const phone = `91${national}`;
    const scope = input?.clientId ? { clientId: String(input.clientId) } : {};
    const archivedAs = `archived:${Date.now()}:${phone}`;
    return this.prisma.$transaction(async (tx) => {
      const cases = await tx.application.updateMany({ where: { workerPhone: phone, ...scope }, data: { workerPhone: archivedAs, status: "ARCHIVED" } });
      const passkeys = await tx.workerPasskey.deleteMany({ where: { workerPhone: phone, ...scope } });
      return { phone: `******${national.slice(-4)}`, casesArchived: cases.count, passkeysRemoved: passkeys.count };
    });
  }
}
