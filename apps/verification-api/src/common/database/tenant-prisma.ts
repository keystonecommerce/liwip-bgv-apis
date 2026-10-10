import { Prisma, PrismaClient } from "@prisma/client";
export interface TenantOwner { tenantId: string; clientId: string }
const fieldsByModel = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, new Set(model.fields.filter(f => f.kind === "scalar").map(f => f.name))]));
/** Schema-derived direct ownership, plus ownership through parent-only models.
 * Matches Keystone Main Backend's scoped Prisma pattern with client isolation. */
export function withTenantScope(prisma: PrismaClient, owner: TenantOwner) {
  if (!owner.tenantId || !owner.clientId) throw new Error("Tenant and client ownership are required");
  const constraint = (model: string): Record<string, unknown> | undefined => {
    const fields = fieldsByModel.get(model);
    if (fields?.has("tenantId") && fields.has("clientId")) return { tenantId: owner.tenantId, clientId: owner.clientId };
    if (model === "Verification") return { application: { tenantId: owner.tenantId, clientId: owner.clientId } };
    if (model === "ApiKey") return { clientId: owner.clientId, client: { tenantId: owner.tenantId } };
    if (model === "Client") return { id: owner.clientId, tenantId: owner.tenantId };
    return undefined;
  };
  return prisma.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    const scope = constraint(model);
    if (!scope) return query(args);
    const mutable = args as Record<string, any>;
    if (["findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow", "count", "aggregate", "groupBy", "update", "updateMany", "delete", "deleteMany", "upsert"].includes(operation)) {
      const original = mutable.where ?? {};
      mutable.where = { ...original, AND: [original.AND ?? {}, scope] };
    }
    if (["create", "createMany", "upsert", "update", "updateMany"].includes(operation)) {
      const validate = (data: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(data)) {
          if (key === "tenantId" && value !== owner.tenantId || key === "clientId" && value !== owner.clientId) throw new Error("Cannot change tenant ownership");
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
