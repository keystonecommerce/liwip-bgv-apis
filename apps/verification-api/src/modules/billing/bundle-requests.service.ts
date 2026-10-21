import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { availableCheckTypes, isCheckAvailable } from "../../integrations/surepass/products";
import type { VerificationType } from "../../domain/verification.types";
import { AdminContext, scopedTenantId } from "../admin-access/admin-context";
import { id, optionalText, text } from "../admin-panel/input";
import { BUNDLED_CHECKS } from "./catalog.service";
import { checkType, pickRate } from "./check-rates.service";

/** REQUESTED → PRICED (Keystone) → ACCEPTED (partner; the private package goes on sale) or DECLINED / WITHDRAWN. */
export type BundleStatus = "REQUESTED" | "PRICED" | "ACCEPTED" | "DECLINED" | "WITHDRAWN";

type BundleRow = Prisma.BundleRequestGetPayload<{ include: { tenant: { select: { id: true; name: true } } } }>;

export interface BundleRequestInput { name?: unknown; checks?: unknown; expectedSeats?: unknown; note?: unknown }
export interface BundlePriceInput { unitPricePaise?: unknown; maxSeatsPerOrder?: unknown; validDays?: unknown; note?: unknown }

const MANUAL = new Set<string>(["CURRENT_ADDRESS", "REFERENCE_CHECK", "SKILL_CERTIFICATION"]);

function whole(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new BadRequestException(`${label} must be a whole number from ${min} to ${max}`);
  return value as number;
}

/** What a partner sees: never Keystone's costs or margins. */
const partnerView = (row: BundleRow) => ({
  id: row.id, name: row.name, checks: row.checks as string[], expectedSeats: row.expectedSeats, note: row.note, status: row.status as BundleStatus,
  partner: row.tenant, createdAt: row.createdAt, updatedAt: row.updatedAt,
  offer: row.unitPricePaise === null ? null : { unitPricePaise: row.unitPricePaise, maxSeatsPerOrder: row.maxSeatsPerOrder, validUntil: row.priceValidUntil, note: row.replyNote, pricedAt: row.pricedAt },
  expired: row.status === "PRICED" && Boolean(row.priceValidUntil && row.priceValidUntil < new Date()),
  replyNote: row.replyNote, closedBy: row.closedBy, closedAt: row.closedAt, acceptedAt: row.acceptedAt, packageId: row.packageId
});

/**
 * Custom bundles (PRICING-AND-PAYMENTS.md §2a). A partner picks checks and asks for a price;
 * Keystone sees its cost and list prices, then offers a price per seat with a seat limit per
 * order; accepting puts a private package on sale to that partner, bought like any other.
 */
@Injectable()
export class BundleRequestsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The checks a bundle can hold. Aadhaar is in every bundle, so it is not a choice. */
  requestableChecks() {
    return { included: [...BUNDLED_CHECKS], items: availableCheckTypes().filter((type) => !(BUNDLED_CHECKS as readonly string[]).includes(type)) };
  }

  async list(admin: AdminContext, status?: string) {
    const tenantId = scopedTenantId(admin);
    const rows = await this.prisma.bundleRequest.findMany({
      where: { ...(tenantId ? { tenantId } : {}), ...(status ? { status: String(status).toUpperCase() } : {}) },
      orderBy: { createdAt: "desc" }, take: 200, include: { tenant: { select: { id: true, name: true } } }
    });
    return { items: rows.map(partnerView) };
  }

  async get(admin: AdminContext, requestId: string) {
    return partnerView(await this.find(admin, requestId));
  }

  async create(admin: AdminContext, tenantId: string, input: BundleRequestInput) {
    const checks = this.checks(input?.checks);
    const open = await this.prisma.bundleRequest.count({ where: { tenantId, status: { in: ["REQUESTED", "PRICED"] } } });
    if (open >= 20) throw new ConflictException("You have 20 bundles waiting. Accept or withdraw some first.");
    const row = await this.prisma.bundleRequest.create({
      data: {
        id: `bundle_${randomUUID()}`, tenantId, name: text(input?.name, "name", 80, 2), checks, requestedById: admin.user.id,
        expectedSeats: input?.expectedSeats === undefined || input.expectedSeats === null ? null : whole(input.expectedSeats, "expectedSeats", 1, 1_000_000),
        note: optionalText(input?.note, "note", 500) ?? null
      },
      include: { tenant: { select: { id: true, name: true } } }
    });
    admin.audit = { tenantId, resourceType: "BundleRequest", resourceId: row.id, metadata: { checks } };
    return partnerView(row);
  }

  /** The partner takes the price: a private package goes on sale to them at that price and seat limit. */
  async accept(admin: AdminContext, requestId: string) {
    const request = await this.find(admin, requestId);
    if (request.status !== "PRICED" || request.unitPricePaise === null) throw new ConflictException("There is no price to accept yet");
    if (request.priceValidUntil && request.priceValidUntil < new Date()) throw new ConflictException("This price has expired. Ask Keystone for a new one.");
    const checks = request.checks as string[];
    const row = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.bundleRequest.updateMany({ where: { id: request.id, status: "PRICED", unitPricePaise: request.unitPricePaise }, data: { status: "ACCEPTED", acceptedById: admin.user.id, acceptedAt: new Date() } });
      if (!claimed.count) throw new ConflictException("This bundle changed. Reload and try again.");
      const pkg = await tx.verificationPackage.create({
        data: {
          id: `package_${randomUUID()}`, code: `CUSTOM_${randomBytes(4).toString("hex").toUpperCase()}`, version: 1, name: request.name,
          description: "Custom bundle", kind: "BASE", status: "PUBLISHED", isActive: true, publishedAt: new Date(), tenantId: request.tenantId,
          listPricePaise: request.unitPricePaise, priceInr: Math.round(request.unitPricePaise! / 100), maxSeatsPerOrder: request.maxSeatsPerOrder,
          checks: checks.map((type) => ({ type, mode: "REQUIRED", execution: MANUAL.has(type) ? "MANUAL" : "PROVIDER" })), displayOrder: 50, createdById: admin.user.id
        }
      });
      return tx.bundleRequest.update({ where: { id: request.id }, data: { packageId: pkg.id }, include: { tenant: { select: { id: true, name: true } } } });
    });
    admin.audit = { tenantId: request.tenantId, resourceType: "BundleRequest", resourceId: request.id, metadata: { packageId: row.packageId, unitPricePaise: request.unitPricePaise } };
    return partnerView(row);
  }

  /** The partner declines a price, or withdraws a request that has none yet. */
  async decline(admin: AdminContext, requestId: string) {
    const request = await this.find(admin, requestId);
    if (request.status !== "REQUESTED" && request.status !== "PRICED") throw new ConflictException("This bundle is already closed");
    const status = request.status === "PRICED" ? "DECLINED" : "WITHDRAWN";
    const row = await this.prisma.bundleRequest.update({ where: { id: request.id }, data: { status, closedBy: "PARTNER", closedAt: new Date() }, include: { tenant: { select: { id: true, name: true } } } });
    admin.audit = { tenantId: request.tenantId, resourceType: "BundleRequest", resourceId: request.id, metadata: { status } };
    return partnerView(row);
  }

  // Keystone

  /**
   * Keystone only: what the bundle costs us and sells for check by check, so a price can be set
   * with a margin. Costs come from CheckCost; list prices from CheckRate.
   */
  async evaluation(requestId: string) {
    const request = await this.prisma.bundleRequest.findUnique({ where: { id: id(requestId, "requestId") }, include: { tenant: { select: { id: true, name: true } } } });
    if (!request) throw new NotFoundException("Bundle request not found");
    const types = [...BUNDLED_CHECKS, ...(request.checks as string[])];
    const [costs, rates] = await Promise.all([
      this.prisma.checkCost.findMany({ where: { checkType: { in: types } } }),
      this.prisma.checkRate.findMany({ where: { checkType: { in: types }, OR: [{ tenantId: null }, { tenantId: request.tenantId }] } })
    ]);
    const now = new Date();
    const lines = types.map((type) => ({
      checkType: type,
      bundled: (BUNDLED_CHECKS as readonly string[]).includes(type),
      costPaise: costs.find((cost) => cost.checkType === type)?.unitCostPaise ?? null,
      listPricePaise: pickRate(rates, null, type, now)?.unitPricePaise ?? null,
      partnerPricePaise: pickRate(rates, request.tenantId, type, now)?.tenantId === request.tenantId ? pickRate(rates, request.tenantId, type, now)!.unitPricePaise : null
    }));
    const sum = (values: Array<number | null>) => (values.every((value) => value !== null) ? (values as number[]).reduce((total, value) => total + value, 0) : null);
    return {
      request: partnerView(request),
      lines,
      costPaise: sum(lines.map((line) => line.costPaise)),
      listPricePaise: sum(lines.map((line) => line.listPricePaise)),
      missingCosts: lines.filter((line) => line.costPaise === null).map((line) => line.checkType)
    };
  }

  /** Keystone sends (or changes) the price: per seat, the most seats per order, and how long it holds. */
  async price(admin: AdminContext, requestId: string, input: BundlePriceInput) {
    const request = await this.prisma.bundleRequest.findUnique({ where: { id: id(requestId, "requestId") } });
    if (!request) throw new NotFoundException("Bundle request not found");
    if (request.status !== "REQUESTED" && request.status !== "PRICED") throw new ConflictException("This bundle is already closed");
    const validDays = input?.validDays === undefined ? 30 : whole(input.validDays, "validDays", 1, 365);
    const row = await this.prisma.bundleRequest.update({
      where: { id: request.id },
      data: {
        status: "PRICED", unitPricePaise: whole(input?.unitPricePaise, "unitPricePaise", 100, 10_000_000),
        maxSeatsPerOrder: input?.maxSeatsPerOrder === undefined || input.maxSeatsPerOrder === null ? null : whole(input.maxSeatsPerOrder, "maxSeatsPerOrder", 1, 100_000),
        priceValidUntil: new Date(Date.now() + validDays * 86_400_000), replyNote: optionalText(input?.note, "note", 500) ?? null, pricedById: admin.user.id, pricedAt: new Date()
      },
      include: { tenant: { select: { id: true, name: true } } }
    });
    admin.audit = { tenantId: request.tenantId, resourceType: "BundleRequest", resourceId: request.id, metadata: { unitPricePaise: row.unitPricePaise, maxSeatsPerOrder: row.maxSeatsPerOrder, validDays } };
    return partnerView(row);
  }

  /** Keystone won't offer this bundle; the note says why. */
  async reject(admin: AdminContext, requestId: string, note: unknown) {
    const request = await this.prisma.bundleRequest.findUnique({ where: { id: id(requestId, "requestId") } });
    if (!request) throw new NotFoundException("Bundle request not found");
    if (request.status !== "REQUESTED" && request.status !== "PRICED") throw new ConflictException("This bundle is already closed");
    const row = await this.prisma.bundleRequest.update({
      where: { id: request.id }, data: { status: "DECLINED", closedBy: "KEYSTONE", closedAt: new Date(), replyNote: text(note, "note", 500, 5) },
      include: { tenant: { select: { id: true, name: true } } }
    });
    admin.audit = { tenantId: request.tenantId, resourceType: "BundleRequest", resourceId: request.id };
    return partnerView(row);
  }

  /** Keystone: what each check costs us. */
  async listCosts() {
    return { items: await this.prisma.checkCost.findMany({ orderBy: { checkType: "asc" } }) };
  }

  async setCost(admin: AdminContext, typeValue: string, input: { unitCostPaise?: unknown; note?: unknown }) {
    const type = checkType(typeValue);
    const unitCostPaise = whole(input?.unitCostPaise, "unitCostPaise", 0, 10_000_000);
    const note = optionalText(input?.note, "note", 200) ?? null;
    const row = await this.prisma.checkCost.upsert({ where: { checkType: type }, create: { checkType: type, unitCostPaise, note, updatedById: admin.user.id }, update: { unitCostPaise, note, updatedById: admin.user.id } });
    admin.audit = { resourceType: "CheckCost", resourceId: type, metadata: { unitCostPaise } };
    return row;
  }

  private async find(admin: AdminContext, requestId: string) {
    const tenantId = scopedTenantId(admin);
    const row = await this.prisma.bundleRequest.findFirst({ where: { id: id(requestId, "requestId"), ...(tenantId ? { tenantId } : {}) }, include: { tenant: { select: { id: true, name: true } } } });
    if (!row) throw new NotFoundException("Bundle request not found");
    return row;
  }

  private checks(value: unknown): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 30) throw new BadRequestException("Choose 1 to 30 checks");
    const types = [...new Set(value.map((item) => checkType(item)))].filter((type) => !(BUNDLED_CHECKS as readonly string[]).includes(type));
    if (!types.length) throw new BadRequestException("Choose at least one check besides Aadhaar");
    const unavailable = types.filter((type) => !isCheckAvailable(type as VerificationType));
    if (unavailable.length) throw new BadRequestException(`Not available: ${unavailable.join(", ")}`);
    return types;
  }
}
