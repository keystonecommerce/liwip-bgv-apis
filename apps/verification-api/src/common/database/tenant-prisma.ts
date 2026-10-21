import { Prisma, PrismaClient } from "@prisma/client";
/** One program (client) of one partner (tenant): partner API keys and worker sessions. */
export interface TenantOwner { tenantId: string; clientId: string }
/** Every program of one partner: partner staff in the admin panel. Must be asked for explicitly. */
export interface PartnerOwner { tenantId: string; allPrograms: true }
const models = Prisma.dmmf.datamodel.models;
const fieldsByModel = new Map(models.map(model => [model.name, new Set(model.fields.filter(f => f.kind === "scalar").map(f => f.name))]));
const ownedThroughApplication = new Set(models.filter(model => model.fields.some(f => f.kind === "object" && f.name === "application" && f.type === "Application")).map(model => model.name));
/** Schema-derived direct ownership, plus ownership through parent-only models.
 * Matches Keystone Main Backend's scoped Prisma pattern with client isolation. */
export function withTenantScope(prisma: PrismaClient, owner: TenantOwner | PartnerOwner) {
  const allPrograms = "allPrograms" in owner && owner.allPrograms === true;
  const clientId = allPrograms ? undefined : (owner as TenantOwner).clientId;
  if (!owner.tenantId || (!allPrograms && !clientId)) throw new Error("Tenant and client ownership are required");
  const own = allPrograms ? { tenantId: owner.tenantId } : { tenantId: owner.tenantId, clientId };
  const constraint = (model: string): Record<string, unknown> | undefined => {
    if (model === "Tenant") return { id: owner.tenantId };
    if (model === "Client") return allPrograms ? { tenantId: owner.tenantId } : { id: clientId, tenantId: owner.tenantId };
    if (model === "ApiKey") return allPrograms ? { client: { tenantId: owner.tenantId } } : { clientId, client: { tenantId: owner.tenantId } };
    const fields = fieldsByModel.get(model);
    if (fields?.has("tenantId") && fields.has("clientId")) return own;
    // Tenant-owned rows without a program (e.g. StaffRoleBinding) belong to the whole partner.
    if (fields?.has("tenantId")) return { tenantId: owner.tenantId };
    if (ownedThroughApplication.has(model)) return { application: own };
    return undefined;
  };
  return prisma.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    const scope = constraint(model);
    if (!scope) return query(args);
    const mutable = args as Record<string, any>;
    if (["findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow", "count", "aggregate", "groupBy", "update", "updateMany", "delete", "deleteMany", "upsert"].includes(operation)) {
      const original = mutable.where ?? {};
      // Keep the caller's AND (object or array) and add the scope beside it.
      const existing = original.AND === undefined ? [] : Array.isArray(original.AND) ? original.AND : [original.AND];
      mutable.where = { ...original, AND: [...existing, scope] };
    }
    if (["create", "createMany", "upsert", "update", "updateMany"].includes(operation)) {
      const validate = (data: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(data)) {
          // With allPrograms the composite (clientId, tenantId) foreign keys keep a program inside its partner.
          if (key === "tenantId" && value !== owner.tenantId || key === "clientId" && !allPrograms && value !== clientId) throw new Error("Cannot change tenant ownership");
          if (value && typeof value === "object" && ["tenant", "client", "application"].includes(key)) throw new Error("Nested ownership mutations are not allowed in scoped queries");
        }
        return data;
      };
      if (mutable.data) (Array.isArray(mutable.data) ? mutable.data : [mutable.data]).forEach(validate);
      if (mutable.create) validate(mutable.create);
      if (mutable.update) validate(mutable.update);
    }
    return query(args);
  } } } });
}
export type ScopedPrisma = ReturnType<typeof withTenantScope>;
