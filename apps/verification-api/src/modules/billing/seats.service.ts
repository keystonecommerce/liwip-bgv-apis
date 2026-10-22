import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";

type Tx = Prisma.TransactionClient;

/**
 * Seats are an append-only ledger per partner, package code and version.
 * PURCHASE +n · RESERVE −1 (link sent) · RELEASE +1 (link expired or cancelled) ·
 * CONSUME 0 (a reserved seat used: it only records the move) · ADJUST ±n (Keystone, with a reason).
 */
@Injectable()
export class SeatsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Available seats per package code, oldest version first. */
  async balances(tenantId: string, db: Tx | PrismaService = this.prisma) {
    const rows = await db.seatLedger.groupBy({ by: ["packageCode", "packageVersion", "kind"], where: { tenantId }, _sum: { delta: true } });
    const byCode = new Map<string, { packageCode: string; available: number; purchased: number; reserved: number; used: number; versions: Array<{ version: number; available: number }> }>();
    const reservedOpen = await db.invite.groupBy({ by: ["packageCode"], where: { tenantId, status: { in: ["SENT"] } }, _count: { _all: true } });
    const used = await db.seatLedger.groupBy({ by: ["packageCode"], where: { tenantId, kind: "CONSUME" }, _count: { _all: true } });
    for (const row of rows) {
      const entry = byCode.get(row.packageCode) ?? { packageCode: row.packageCode, available: 0, purchased: 0, reserved: 0, used: 0, versions: [] };
      const sum = row._sum.delta ?? 0;
      entry.available += sum;
      if (row.kind === "PURCHASE") entry.purchased += sum;
      const version = entry.versions.find((item) => item.version === row.packageVersion) ?? (entry.versions.push({ version: row.packageVersion, available: 0 }), entry.versions.at(-1)!);
      version.available += sum;
      byCode.set(row.packageCode, entry);
    }
    for (const entry of byCode.values()) {
      entry.reserved = reservedOpen.find((row) => row.packageCode === entry.packageCode)?._count._all ?? 0;
      entry.used = used.find((row) => row.packageCode === entry.packageCode)?._count._all ?? 0;
      entry.versions.sort((a, b) => a.version - b.version);
    }
    return [...byCode.values()].sort((a, b) => a.packageCode.localeCompare(b.packageCode));
  }

  /** Serialises seat changes for one partner and package inside a transaction. */
  async lock(tx: Tx, tenantId: string, packageCode: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seats:${tenantId}:${packageCode}`}))`;
  }

  /**
   * Reserves one seat per invite, oldest version first. Call inside a transaction after lock().
   * Returns the version each invite took, in order.
   */
  async reserve(tx: Tx, tenantId: string, packageCode: string, inviteIds: string[]): Promise<number[]> {
    const balance = (await this.balances(tenantId, tx)).find((item) => item.packageCode === packageCode);
    const available = balance?.available ?? 0;
    if (available < inviteIds.length) throw new ConflictException(`Not enough ${packageCode} seats: need ${inviteIds.length}, have ${available}. Buy more first.`);
    const pool = (balance?.versions ?? []).filter((item) => item.available > 0).flatMap((item) => Array.from({ length: item.available }, () => item.version));
    const versions = inviteIds.map((_, index) => pool[index]);
    await tx.seatLedger.createMany({ data: inviteIds.map((inviteId, index) => ({ id: `seat_${randomUUID()}`, tenantId, packageCode, packageVersion: versions[index], delta: -1, kind: "RESERVE", inviteId })) });
    return versions;
  }

  release(tx: Tx, invite: { id: string; tenantId: string; packageCode: string; packageVersion: number }, reason: string) {
    return tx.seatLedger.create({ data: { id: `seat_${randomUUID()}`, tenantId: invite.tenantId, packageCode: invite.packageCode, packageVersion: invite.packageVersion, delta: 1, kind: "RELEASE", inviteId: invite.id, reason } });
  }

  consume(tx: Tx, invite: { id: string; tenantId: string; packageCode: string; packageVersion: number }) {
    return tx.seatLedger.create({ data: { id: `seat_${randomUUID()}`, tenantId: invite.tenantId, packageCode: invite.packageCode, packageVersion: invite.packageVersion, delta: 0, kind: "CONSUME", inviteId: invite.id } });
  }

  purchase(tx: Tx, line: { tenantId: string; packageCode: string; packageVersion: number; quantity: number; id: string }) {
    return tx.seatLedger.create({ data: { id: `seat_${randomUUID()}`, tenantId: line.tenantId, packageCode: line.packageCode, packageVersion: line.packageVersion, delta: line.quantity, kind: "PURCHASE", orderLineId: line.id } });
  }

  /** Keystone adds or removes seats by hand. Removal cannot take the balance below zero. */
  async adjust(input: { tenantId: string; packageCode: string; delta: number; reason: string; createdById: string }) {
    if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 100_000) throw new BadRequestException("delta must be a non-zero whole number");
    if (input.reason.trim().length < 5) throw new BadRequestException("Give a reason of at least 5 characters");
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, input.tenantId, input.packageCode);
      const balance = (await this.balances(input.tenantId, tx)).find((item) => item.packageCode === input.packageCode);
      const versions = balance?.versions ?? [];
      if (input.delta < 0 && (balance?.available ?? 0) + input.delta < 0) throw new ConflictException(`Only ${balance?.available ?? 0} seats are available to remove`);
      // Additions go to the newest version on record (or the live one); removals come off the oldest.
      let version = versions.at(-1)?.version;
      if (version === undefined) {
        const live = await tx.verificationPackage.findFirst({ where: { code: input.packageCode, status: "PUBLISHED" }, select: { version: true } });
        if (!live) throw new BadRequestException(`${input.packageCode} is not on sale`);
        version = live.version;
      }
      if (input.delta < 0) version = versions.find((item) => item.available > 0)?.version ?? version;
      await tx.seatLedger.create({ data: { id: `seat_${randomUUID()}`, tenantId: input.tenantId, packageCode: input.packageCode, packageVersion: version, delta: input.delta, kind: "ADJUST", reason: input.reason.trim(), createdById: input.createdById } });
      return (await this.balances(input.tenantId, tx)).find((item) => item.packageCode === input.packageCode);
    });
  }
}
