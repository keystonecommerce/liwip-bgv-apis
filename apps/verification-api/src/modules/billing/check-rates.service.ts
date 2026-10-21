import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { CheckRate } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import type { AdminContext } from "../admin-access/admin-context";
import { id, optionalDate } from "../admin-panel/input";

export interface CheckRateInput {
  tenantId?: string | null;
  checkType?: string;
  unitPricePaise?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

type RateRow = Pick<CheckRate, "id" | "tenantId" | "checkType" | "unitPricePaise" | "validFrom" | "validTo" | "isActive" | "createdAt">;

export function checkType(value: unknown): string {
  const type = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(type)) throw new BadRequestException("Check type must be 2 to 40 capital letters, digits or _, such as PAN");
  return type;
}

const activeOn = (row: RateRow, at: Date) => row.isActive && (!row.validFrom || row.validFrom <= at) && (!row.validTo || row.validTo > at);
const newest = (a: RateRow, b: RateRow) => (b.validFrom?.getTime() ?? 0) - (a.validFrom?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime();

/**
 * The rate for one check at one moment: the partner's own rate if one is active, else the list
 * rate. Within a scope the most recently started rate wins.
 */
export function pickRate<T extends RateRow>(rows: readonly T[], tenantId: string | null, type: string, at: Date): T | null {
  const live = rows.filter((row) => row.checkType === type && activeOn(row, at));
  const own = tenantId ? live.filter((row) => row.tenantId === tenantId).sort(newest) : [];
  return own[0] ?? live.filter((row) => row.tenantId === null).sort(newest)[0] ?? null;
}

/** Keystone's per-check price list: list prices and partners' own prices. */
@Injectable()
export class CheckRatesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(tenantId?: string | null) {
    const items = await this.prisma.checkRate.findMany({ where: tenantId === undefined ? {} : { tenantId }, orderBy: [{ checkType: "asc" }, { tenantId: "asc" }, { createdAt: "desc" }] });
    return { items };
  }

  async create(admin: AdminContext, input: CheckRateInput) {
    const tenantId = input.tenantId ? id(input.tenantId, "tenantId") : null;
    if (tenantId && !(await this.prisma.tenant.count({ where: { id: tenantId } }))) throw new NotFoundException("Partner not found");
    const row = await this.prisma.checkRate.create({
      data: {
        id: `crate_${randomUUID()}`, tenantId, checkType: checkType(input.checkType), unitPricePaise: price(input.unitPricePaise),
        validFrom: optionalDate(input.validFrom, "validFrom") ?? null, validTo: optionalDate(input.validTo, "validTo") ?? null, createdById: admin.user.id
      }
    });
    admin.audit = { tenantId, resourceType: "CheckRate", resourceId: row.id, metadata: { checkType: row.checkType, unitPricePaise: row.unitPricePaise } };
    return row;
  }

  /** Changing a price only affects checks not yet charged: every charge keeps the price it was billed at. */
  async update(admin: AdminContext, rateId: string, input: CheckRateInput) {
    const rate = await this.prisma.checkRate.findUnique({ where: { id: id(rateId, "rateId") } });
    if (!rate) throw new NotFoundException("Check price not found");
    const row = await this.prisma.checkRate.update({
      where: { id: rate.id },
      data: {
        unitPricePaise: input.unitPricePaise === undefined ? rate.unitPricePaise : price(input.unitPricePaise),
        validFrom: input.validFrom === undefined ? rate.validFrom : optionalDate(input.validFrom, "validFrom") ?? null,
        validTo: input.validTo === undefined ? rate.validTo : optionalDate(input.validTo, "validTo") ?? null,
        isActive: input.isActive === undefined ? rate.isActive : input.isActive === true
      }
    });
    admin.audit = { tenantId: rate.tenantId, resourceType: "CheckRate", resourceId: rate.id, metadata: { checkType: rate.checkType, from: rate.unitPricePaise, to: row.unitPricePaise } };
    return row;
  }

  /** Every rate row that could price these types for this buyer (list and, if given, the partner's own). */
  rowsFor(tenantId: string | null, types?: string[]) {
    return this.prisma.checkRate.findMany({ where: { ...(types ? { checkType: { in: types } } : {}), OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])] } });
  }
}

function price(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 10_000_000) throw new BadRequestException("unitPricePaise must be whole paise from 100 to 10000000");
  return value as number;
}
