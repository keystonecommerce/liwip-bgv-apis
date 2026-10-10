import { Inject, Injectable } from "@nestjs/common";
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
}
