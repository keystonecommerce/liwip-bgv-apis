import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ON_FAIL } from "../../domain/final-result";
import { BGV_MODULES, moduleOf } from "../../domain/modules";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import type { AdminContext } from "../admin-access/admin-context";
import { id, oneOf, optionalDate, optionalText, text } from "../admin-panel/input";
import { checkType, CheckRatesService, pickRate } from "./check-rates.service";
import type { AddOnItem, DiscountTier, PricedItem } from "./pricing";

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** Add-ons are check types priced from CheckRate, not packages of their own. */
const KINDS = ["BASE"] as const;
const MODULES = BGV_MODULES;

/**
 * A Vehicle package holds only vehicle checks. A People package may add vehicle checks: a driver
 * verified with their vehicle.
 */
function checkModules(module: string, checks: Prisma.InputJsonValue): void {
  const outside = (checks as Array<{ type: string }>).filter((check) => module === "VEHICLE" && moduleOf(check.type) !== "VEHICLE").map((check) => check.type);
  if (outside.length) throw new BadRequestException(`A Vehicle package holds only vehicle checks; move ${outside.join(", ")} to a People package`);
}

export interface PackageInput {
  code?: string;
  name?: string;
  description?: string | null;
  role?: string | null;
  module?: string;
  kind?: string;
  listPricePaise?: number;
  checks?: unknown;
  displayOrder?: number;
  /** Most seats one order may buy; null removes the limit. */
  maxSeatsPerOrder?: number | null;
}

export interface DiscountRuleInput {
  tenantId?: string | null;
  packageCode?: string | null;
  minQty?: number;
  maxQty?: number | null;
  percentOffBps?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

export interface PartnerPriceInput {
  packageCode?: string;
  unitPricePaise?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

type PackageRow = Prisma.VerificationPackageGetPayload<object>;

/** The check types in a package's checks JSON. */
export const checkTypesOf = (checks: unknown): string[] => (Array.isArray(checks) ? checks.map((item) => String((item as { type?: unknown })?.type ?? "")).filter(Boolean) : []);

/** In every package whatever it lists: the Liwip app starts every case with Aadhaar. Never an add-on or a usage charge. */
export const BUNDLED_CHECKS = ["AADHAAR"] as const;

/** What a package's price pays for: its own checks plus the bundled ones. */
export const includedChecks = (checks: unknown): string[] => [...new Set([...BUNDLED_CHECKS, ...checkTypesOf(checks)])];

export function packageCode(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  if (!CODE.test(code)) throw new BadRequestException("Package code must be 2 to 40 capital letters, digits or _");
  return code;
}

function paise(value: unknown, label: string, min = 100): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > 100_000_000) throw new BadRequestException(`${label} must be whole paise of at least ${min}`);
  return value as number;
}

function wholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new BadRequestException(`${label} must be a whole number from ${min} to ${max}`);
  return value as number;
}

/** [{ type, mode?, execution? }], the shape packages already use. */
function checksOf(value: unknown): Prisma.InputJsonValue {
  if (!Array.isArray(value) || !value.length || value.length > 40) throw new BadRequestException("checks must list 1 to 40 checks");
  const seen = new Set<string>();
  return value.map((item) => {
    const type = String((item as { type?: unknown })?.type ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(type)) throw new BadRequestException("Each check needs a type such as PAN");
    if (seen.has(type)) throw new BadRequestException(`${type} is listed twice`);
    seen.add(type);
    const mode = oneOf((item as { mode?: unknown }).mode ?? "REQUIRED", "mode", ["REQUIRED", "OPTIONAL"] as const);
    const execution = oneOf((item as { execution?: unknown }).execution ?? "PROVIDER", "execution", ["PROVIDER", "MANUAL"] as const);
    // What a failure of this check does to the case's final result (domain/final-result.ts).
    const onFail = (item as { onFail?: unknown }).onFail === undefined ? undefined : oneOf((item as { onFail?: unknown }).onFail, "onFail", ON_FAIL);
    return { type, mode, execution, ...(onFail ? { onFail } : {}) };
  });
}

const activeAt = (now: Date) => ({
  isActive: true,
  AND: [
    { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
    { OR: [{ validTo: null }, { validTo: { gt: now } }] }
  ]
});

/** Packages a buyer may see: on sale to everyone, plus a partner's own custom bundles. */
const visibleTo = (tenantId: string | null): Prisma.VerificationPackageWhereInput => (tenantId ? { OR: [{ tenantId: null }, { tenantId }] } : { tenantId: null });

const seatLimit = (value: unknown) => (value === undefined ? undefined : value === null ? null : wholeNumber(value, "maxSeatsPerOrder", 1, 100_000));

const view = (row: PackageRow) => ({
  id: row.id, code: row.code, version: row.version, name: row.name, description: row.description, role: row.role, module: row.module,
  kind: row.kind, status: row.status, listPricePaise: row.listPricePaise, checks: row.checks, displayOrder: row.displayOrder,
  tenantId: row.tenantId, maxSeatsPerOrder: row.maxSeatsPerOrder,
  publishedAt: row.publishedAt, updatedAt: row.updatedAt
});

@Injectable()
export class CatalogService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CheckRatesService) private readonly rates: CheckRatesService) {}

  /** Keystone: every package code with its live and draft versions. */
  async listPackages() {
    const rows = await this.prisma.verificationPackage.findMany({ where: { status: { in: ["PUBLISHED", "DRAFT"] } }, orderBy: [{ displayOrder: "asc" }, { code: "asc" }, { version: "desc" }] });
    const addOns = await this.prisma.packageAddOn.findMany({ orderBy: { displayOrder: "asc" } });
    const byCode = new Map<string, { code: string; live: ReturnType<typeof view> | null; draft: ReturnType<typeof view> | null; addOnChecks: string[] }>();
    for (const row of rows) {
      const entry = byCode.get(row.code) ?? { code: row.code, live: null, draft: null, addOnChecks: addOns.filter((item) => item.basePackageCode === row.code).map((item) => item.addOnCode) };
      if (row.status === "PUBLISHED") entry.live = view(row);
      if (row.status === "DRAFT") entry.draft = view(row);
      byCode.set(row.code, entry);
    }
    return { items: [...byCode.values()] };
  }

  /** A new package starts as draft version 1. */
  async createPackage(admin: AdminContext, input: PackageInput) {
    const code = packageCode(input.code);
    if (await this.prisma.verificationPackage.count({ where: { code } })) throw new ConflictException(`${code} already exists; edit its draft instead`);
    const kind = oneOf(input.kind ?? "BASE", "kind", KINDS);
    const module = oneOf(input.module ?? "PEOPLE", "module", MODULES);
    const checks = checksOf(input.checks);
    checkModules(module, checks);
    const row = await this.prisma.verificationPackage.create({
      data: {
        id: `package_${randomUUID()}`, code, version: 1, status: "DRAFT", isActive: false,
        name: text(input.name, "name", 80), description: optionalText(input.description, "description", 300) ?? null,
        role: kind === "BASE" ? (optionalText(input.role, "role", 40)?.toUpperCase() ?? null) : null,
        module, kind,
        listPricePaise: paise(input.listPricePaise, "listPricePaise"), priceInr: Math.round(paise(input.listPricePaise, "listPricePaise") / 100),
        checks, displayOrder: input.displayOrder === undefined ? 100 : wholeNumber(input.displayOrder, "displayOrder", 0, 10_000),
        maxSeatsPerOrder: seatLimit(input.maxSeatsPerOrder) ?? null, createdById: admin.user.id
      }
    });
    admin.audit = { resourceType: "VerificationPackage", resourceId: row.id, metadata: { code, version: 1 } };
    return view(row);
  }

  /** Edits the draft, creating it from the live version when there is none. */
  async saveDraft(admin: AdminContext, codeValue: string, input: PackageInput) {
    const code = packageCode(codeValue);
    const draft = await this.prisma.verificationPackage.findFirst({ where: { code, status: "DRAFT" } });
    const live = await this.prisma.verificationPackage.findFirst({ where: { code, status: "PUBLISHED" } });
    const base = draft ?? live;
    if (!base) throw new NotFoundException(`${code} not found`);
    const listPricePaise = input.listPricePaise === undefined ? base.listPricePaise : paise(input.listPricePaise, "listPricePaise");
    const changes = {
      name: input.name === undefined ? base.name : text(input.name, "name", 80),
      description: input.description === undefined ? base.description : optionalText(input.description, "description", 300) ?? null,
      role: input.role === undefined ? base.role : optionalText(input.role, "role", 40)?.toUpperCase() ?? null,
      module: input.module === undefined ? base.module : oneOf(input.module, "module", MODULES),
      listPricePaise, priceInr: listPricePaise === null ? base.priceInr : Math.round(listPricePaise / 100),
      checks: input.checks === undefined ? (base.checks as Prisma.InputJsonValue) : checksOf(input.checks),
      displayOrder: input.displayOrder === undefined ? base.displayOrder : wholeNumber(input.displayOrder, "displayOrder", 0, 10_000),
      maxSeatsPerOrder: seatLimit(input.maxSeatsPerOrder) === undefined ? base.maxSeatsPerOrder : seatLimit(input.maxSeatsPerOrder)
    };
    checkModules(changes.module, changes.checks);
    const row = draft
      ? await this.prisma.verificationPackage.update({ where: { id: draft.id }, data: changes })
      : await this.prisma.verificationPackage.create({
          data: { ...changes, id: `package_${randomUUID()}`, code, version: await this.nextVersion(code), kind: base.kind, tenantId: base.tenantId, status: "DRAFT", isActive: false, createdById: admin.user.id, advertisedCheckCount: base.advertisedCheckCount, targetWorkforce: base.targetWorkforce }
        });
    admin.audit = { resourceType: "VerificationPackage", resourceId: row.id, metadata: { code, version: row.version } };
    return view(row);
  }

  /** The draft goes live; the old live version retires. Orders and cases keep the version they used. */
  async publish(admin: AdminContext, codeValue: string) {
    const code = packageCode(codeValue);
    const row = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.verificationPackage.findFirst({ where: { code, status: "DRAFT" } });
      if (!draft) throw new NotFoundException(`${code} has no draft to publish`);
      if (!draft.listPricePaise) throw new BadRequestException("Set a price before publishing");
      await tx.verificationPackage.updateMany({ where: { code, status: "PUBLISHED" }, data: { status: "RETIRED", isActive: false } });
      return tx.verificationPackage.update({ where: { id: draft.id }, data: { status: "PUBLISHED", isActive: true, publishedAt: new Date() } });
    });
    admin.audit = { resourceType: "VerificationPackage", resourceId: row.id, metadata: { code, version: row.version } };
    return view(row);
  }

  /** Takes a package off sale. Seats already bought stay usable. */
  async retire(admin: AdminContext, codeValue: string) {
    const code = packageCode(codeValue);
    const result = await this.prisma.verificationPackage.updateMany({ where: { code, status: { in: ["PUBLISHED", "DRAFT"] } }, data: { status: "RETIRED", isActive: false } });
    if (!result.count) throw new NotFoundException(`${code} is not on sale`);
    admin.audit = { resourceType: "VerificationPackage", resourceId: code };
    return { code, status: "RETIRED" };
  }

  /** The extra checks the Liwip app offers with a package. Each needs a list price in CheckRate to be sold. */
  async setAddOns(admin: AdminContext, codeValue: string, addOnChecks: unknown) {
    const code = packageCode(codeValue);
    if (!Array.isArray(addOnChecks) || addOnChecks.length > 20) throw new BadRequestException("addOnChecks must list up to 20 check types");
    const types = [...new Set(addOnChecks.map(checkType))];
    const base = await this.prisma.verificationPackage.findFirst({ where: { code, kind: "BASE" }, orderBy: { version: "desc" } });
    if (!base) throw new NotFoundException(`${code} not found`);
    const included = types.filter((type) => includedChecks(base.checks).includes(type));
    if (included.length) throw new BadRequestException(`Already in ${code}: ${included.join(", ")}`);
    const priced = new Set((await this.prisma.checkRate.findMany({ where: { tenantId: null, checkType: { in: types }, isActive: true }, select: { checkType: true } })).map((row) => row.checkType));
    const unpriced = types.filter((type) => !priced.has(type));
    if (unpriced.length) throw new BadRequestException(`Set a check price first: ${unpriced.join(", ")}`);
    await this.prisma.$transaction([
      this.prisma.packageAddOn.deleteMany({ where: { basePackageCode: code } }),
      this.prisma.packageAddOn.createMany({ data: types.map((addOnCode, index) => ({ id: `addon_${randomUUID()}`, basePackageCode: code, addOnCode, displayOrder: index })) })
    ]);
    admin.audit = { resourceType: "PackageAddOn", resourceId: code, metadata: { addOnChecks: types } };
    return { code, addOnChecks: types };
  }

  // Discount tiers

  listDiscountRules(tenantId?: string) {
    return this.prisma.discountRule.findMany({ where: tenantId ? { tenantId } : {}, orderBy: [{ scope: "asc" }, { packageCode: "asc" }, { minQty: "asc" }] }).then((items) => ({ items }));
  }

  async createDiscountRule(admin: AdminContext, input: DiscountRuleInput) {
    const tenantId = input.tenantId ? id(input.tenantId, "tenantId") : null;
    if (tenantId && !(await this.prisma.tenant.count({ where: { id: tenantId } }))) throw new NotFoundException("Partner not found");
    const minQty = wholeNumber(input.minQty, "minQty", 1, 100_000);
    const maxQty = input.maxQty === undefined || input.maxQty === null ? null : wholeNumber(input.maxQty, "maxQty", minQty, 100_000);
    const row = await this.prisma.discountRule.create({
      data: {
        id: `discount_${randomUUID()}`, scope: tenantId ? "PARTNER" : "GLOBAL", tenantId,
        packageCode: input.packageCode ? packageCode(input.packageCode) : null, minQty, maxQty,
        percentOffBps: wholeNumber(input.percentOffBps, "percentOffBps", 1, 9000),
        validFrom: optionalDate(input.validFrom, "validFrom") ?? null, validTo: optionalDate(input.validTo, "validTo") ?? null,
        createdById: admin.user.id
      }
    });
    admin.audit = { tenantId, resourceType: "DiscountRule", resourceId: row.id };
    return row;
  }

  async updateDiscountRule(admin: AdminContext, ruleId: string, input: DiscountRuleInput) {
    const rule = await this.prisma.discountRule.findUnique({ where: { id: id(ruleId, "ruleId") } });
    if (!rule) throw new NotFoundException("Discount rule not found");
    const minQty = input.minQty === undefined ? rule.minQty : wholeNumber(input.minQty, "minQty", 1, 100_000);
    const maxQty = input.maxQty === undefined ? rule.maxQty : input.maxQty === null ? null : wholeNumber(input.maxQty, "maxQty", minQty, 100_000);
    if (maxQty !== null && maxQty < minQty) throw new BadRequestException("maxQty must be at least minQty");
    const row = await this.prisma.discountRule.update({
      where: { id: rule.id },
      data: {
        minQty, maxQty,
        percentOffBps: input.percentOffBps === undefined ? rule.percentOffBps : wholeNumber(input.percentOffBps, "percentOffBps", 1, 9000),
        validFrom: input.validFrom === undefined ? rule.validFrom : optionalDate(input.validFrom, "validFrom") ?? null,
        validTo: input.validTo === undefined ? rule.validTo : optionalDate(input.validTo, "validTo") ?? null,
        isActive: input.isActive === undefined ? rule.isActive : input.isActive === true
      }
    });
    admin.audit = { tenantId: rule.tenantId, resourceType: "DiscountRule", resourceId: rule.id };
    return row;
  }

  // Partner prices

  listPartnerPrices(tenantId: string) {
    return this.prisma.partnerPrice.findMany({ where: { tenantId }, orderBy: [{ packageCode: "asc" }, { createdAt: "desc" }] }).then((items) => ({ items }));
  }

  async createPartnerPrice(admin: AdminContext, tenantIdValue: string, input: PartnerPriceInput) {
    const tenantId = id(tenantIdValue, "partnerId");
    if (!(await this.prisma.tenant.count({ where: { id: tenantId } }))) throw new NotFoundException("Partner not found");
    const code = packageCode(input.packageCode);
    if (!(await this.prisma.verificationPackage.count({ where: { code, kind: "BASE" } }))) throw new NotFoundException(`${code} is not a base package`);
    const row = await this.prisma.partnerPrice.create({
      data: {
        id: `pprice_${randomUUID()}`, tenantId, packageCode: code, unitPricePaise: paise(input.unitPricePaise, "unitPricePaise"),
        validFrom: optionalDate(input.validFrom, "validFrom") ?? null, validTo: optionalDate(input.validTo, "validTo") ?? null, createdById: admin.user.id
      }
    });
    admin.audit = { tenantId, resourceType: "PartnerPrice", resourceId: row.id, metadata: { packageCode: code, unitPricePaise: row.unitPricePaise } };
    return row;
  }

  async updatePartnerPrice(admin: AdminContext, tenantIdValue: string, priceId: string, input: PartnerPriceInput) {
    const tenantId = id(tenantIdValue, "partnerId");
    const price = await this.prisma.partnerPrice.findFirst({ where: { id: id(priceId, "priceId"), tenantId } });
    if (!price) throw new NotFoundException("Partner price not found");
    const row = await this.prisma.partnerPrice.update({
      where: { id: price.id },
      data: {
        unitPricePaise: input.unitPricePaise === undefined ? price.unitPricePaise : paise(input.unitPricePaise, "unitPricePaise"),
        validFrom: input.validFrom === undefined ? price.validFrom : optionalDate(input.validFrom, "validFrom") ?? null,
        validTo: input.validTo === undefined ? price.validTo : optionalDate(input.validTo, "validTo") ?? null,
        isActive: input.isActive === undefined ? price.isActive : input.isActive === true
      }
    });
    admin.audit = { tenantId, resourceType: "PartnerPrice", resourceId: row.id };
    return row;
  }

  // What a buyer sees and pays

  /**
   * What a buyer sees: published packages at this buyer's price with their add-on checks and the
   * tiers that apply, and (partners) the check prices their API usage is billed at.
   */
  async catalogFor(tenantId: string | null, now = new Date()) {
    const [packages, links, partnerPrices, tiers, rateRows] = await Promise.all([
      this.prisma.verificationPackage.findMany({ where: { status: "PUBLISHED", kind: "BASE", ...visibleTo(tenantId) }, orderBy: [{ displayOrder: "asc" }, { code: "asc" }] }),
      this.prisma.packageAddOn.findMany({ orderBy: { displayOrder: "asc" } }),
      tenantId ? this.prisma.partnerPrice.findMany({ where: { tenantId, ...activeAt(now) }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
      this.tiersFor(tenantId, now),
      this.rates.rowsFor(tenantId)
    ]);
    // Add-ons are bought by individuals at the list price; company seats carry none.
    const listRate = (type: string) => pickRate(rateRows, null, type, now);
    const types = [...new Set(rateRows.map((row) => row.checkType))].sort();
    return {
      packages: packages.filter((row) => row.listPricePaise).map((row) => {
        const partnerPrice = partnerPrices.find((price) => price.packageCode === row.code);
        return {
          code: row.code, version: row.version, name: row.name, description: row.description, role: row.role, module: row.module,
          custom: Boolean(row.tenantId), maxSeatsPerOrder: row.maxSeatsPerOrder,
          checks: row.checks, includedChecks: includedChecks(row.checks), listPricePaise: row.listPricePaise, unitPricePaise: partnerPrice?.unitPricePaise ?? row.listPricePaise,
          addOns: tenantId ? [] : links.filter((link) => link.basePackageCode === row.code).flatMap((link) => {
            const rate = listRate(link.addOnCode);
            return rate ? [{ checkType: link.addOnCode, unitPricePaise: rate.unitPricePaise }] : [];
          })
        };
      }),
      discountTiers: tiers.map(({ id: ruleId, scope, packageCode: code, minQty, maxQty, percentOffBps }) => ({ id: ruleId, scope, packageCode: code, minQty, maxQty, percentOffBps })),
      checkPrices: tenantId ? types.flatMap((type) => { const rate = pickRate(rateRows, tenantId, type, now); return rate ? [{ checkType: type, unitPricePaise: rate.unitPricePaise, own: rate.tenantId === tenantId }] : []; }) : []
    };
  }

  /** Everything the quote needs for the requested codes, at the published versions. */
  async pricingInputs(tenantId: string | null, codes: string[], addOnTypes: string[] = [], now = new Date()) {
    const [rows, links, partnerPrices, rateRows, tiers] = await Promise.all([
      this.prisma.verificationPackage.findMany({ where: { status: "PUBLISHED", kind: "BASE", code: { in: codes }, ...visibleTo(tenantId) } }),
      this.prisma.packageAddOn.findMany({ where: { basePackageCode: { in: codes } } }),
      tenantId ? this.prisma.partnerPrice.findMany({ where: { tenantId, packageCode: { in: codes }, ...activeAt(now) }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
      addOnTypes.length ? this.rates.rowsFor(null, addOnTypes) : Promise.resolve([]),
      this.tiersFor(tenantId, now)
    ]);
    const item = (row: PackageRow): PricedItem => ({ id: row.id, code: row.code, version: row.version, name: row.name, listPricePaise: row.listPricePaise ?? 0 });
    return {
      published: new Map(rows.filter((row) => row.listPricePaise).map((row) => [row.code, { row, item: item(row) }])),
      allowedAddOns: (base: string) => new Set(links.filter((link) => link.basePackageCode === base && !(BUNDLED_CHECKS as readonly string[]).includes(link.addOnCode)).map((link) => link.addOnCode)),
      addOn: (type: string): AddOnItem | null => { const rate = pickRate(rateRows, null, type, now); return rate ? { checkType: type, checkRateId: rate.id, unitPricePaise: rate.unitPricePaise } : null; },
      partnerPrice: (code: string) => partnerPrices.find((price) => price.packageCode === code)?.unitPricePaise ?? null,
      tiers
    };
  }

  private async tiersFor(tenantId: string | null, now: Date): Promise<DiscountTier[]> {
    const rows = await this.prisma.discountRule.findMany({ where: { ...activeAt(now), OR: [{ scope: "GLOBAL" }, ...(tenantId ? [{ scope: "PARTNER", tenantId }] : [])] } });
    return rows.map((row) => ({ id: row.id, scope: row.scope as DiscountTier["scope"], packageCode: row.packageCode, minQty: row.minQty, maxQty: row.maxQty, percentOffBps: row.percentOffBps }));
  }

  private async nextVersion(code: string) {
    const last = await this.prisma.verificationPackage.findFirst({ where: { code }, orderBy: { version: "desc" }, select: { version: true } });
    return (last?.version ?? 0) + 1;
  }
}
