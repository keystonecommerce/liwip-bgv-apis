import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminContext, partnerDb } from "../admin-access/admin-context";
import { Page, oneOf, optionalText, paginated, text } from "./input";

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const PROGRAM_CODE = /^[A-Z0-9][A-Z0-9_-]{1,79}$/;
const CORPORATE_CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export interface PartnerInput {
  slug?: unknown; name?: unknown; legalName?: unknown; gstin?: unknown; address?: unknown; contacts?: unknown; logoUrl?: unknown;
}
export interface ProgramInput { code?: unknown; name?: unknown; corporateCode?: unknown; description?: unknown }

const PARTNER_FIELDS = { id: true, slug: true, name: true, kind: true, status: true, legalName: true, gstin: true, address: true, contacts: true, logoUrl: true, disabledAt: true, createdAt: true, updatedAt: true } as const;
const PROGRAM_FIELDS = { id: true, tenantId: true, code: true, name: true, status: true, corporateCode: true, description: true, disabledAt: true, createdAt: true, updatedAt: true } as const;

function address(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("address must be an object");
  const input = value as Record<string, unknown>;
  const pincode = optionalText(input.pincode, "address.pincode", 10);
  if (pincode && !/^\d{6}$/.test(pincode)) throw new BadRequestException("address.pincode must be 6 digits");
  return {
    line1: text(input.line1, "address.line1", 200),
    line2: optionalText(input.line2, "address.line2", 200) ?? null,
    city: text(input.city, "address.city", 80),
    state: text(input.state, "address.state", 80),
    pincode: pincode ?? null,
    country: optionalText(input.country, "address.country", 60) ?? "India"
  };
}

function contacts(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  if (!Array.isArray(value) || value.length > 10) throw new BadRequestException("contacts must be a list of up to 10 people");
  return value.map((item, index) => {
    const contact = (item ?? {}) as Record<string, unknown>;
    const email = optionalText(contact.email, `contacts[${index}].email`, 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BadRequestException(`contacts[${index}].email is not valid`);
    const phone = optionalText(contact.phone, `contacts[${index}].phone`, 20);
    if (phone && !/^\+?[\d\s-]{8,20}$/.test(phone)) throw new BadRequestException(`contacts[${index}].phone is not valid`);
    return { name: text(contact.name, `contacts[${index}].name`, 80), email: email ?? null, phone: phone ?? null, role: optionalText(contact.role, `contacts[${index}].role`, 60) ?? null };
  });
}

function logoUrl(value: unknown): string | null | undefined {
  const url = optionalText(value, "logoUrl", 500);
  if (!url) return url;
  try {
    if (new URL(url).protocol !== "https:") throw new Error();
  } catch {
    throw new BadRequestException("logoUrl must be an https URL");
  }
  return url;
}

function gstin(value: unknown): string | null | undefined {
  const raw = optionalText(value, "gstin", 15);
  if (!raw) return raw;
  const upper = raw.toUpperCase();
  if (!GSTIN.test(upper)) throw new BadRequestException("gstin is not a valid GSTIN");
  return upper;
}

function corporateCode(value: unknown): string | null | undefined {
  const raw = optionalText(value, "corporateCode", 32);
  if (!raw) return raw;
  const upper = raw.toUpperCase();
  if (!CORPORATE_CODE.test(upper)) throw new BadRequestException("corporateCode must be 3 to 32 letters, digits or hyphens");
  return upper;
}

const conflict = (error: unknown, message: string): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException(message);
  throw error;
};

/** Keystone's partner and program management (GLOBAL), and a partner's own profile (PARTNER). */
@Injectable()
export class PartnersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(query: { search?: string; status?: string }, page: Page) {
    const search = query.search?.trim().slice(0, 80);
    const where: Prisma.TenantWhereInput = {
      ...(query.status ? { status: oneOf(query.status, "status", ["ACTIVE", "DISABLED"] as const) } : {}),
      ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { slug: { contains: search.toLowerCase() } }, { legalName: { contains: search, mode: "insensitive" } }, { clients: { some: { corporateCode: search.toUpperCase() } } }] } : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.tenant.findMany({ where, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.limit, select: { ...PARTNER_FIELDS, _count: { select: { clients: true, applications: true } } } }),
      this.prisma.tenant.count({ where })
    ]);
    return paginated(items.map(({ _count, ...partner }) => ({ ...partner, programCount: _count.clients, caseCount: _count.applications })), total, page);
  }

  async create(admin: AdminContext, input: PartnerInput) {
    const slug = text(input.slug, "slug", 80).toLowerCase();
    if (!SLUG.test(slug)) throw new BadRequestException("slug must be lowercase letters, digits, _ or -");
    const partner = await this.prisma.tenant.create({
      data: {
        id: `tenant_${randomUUID()}`, slug, name: text(input.name, "name"), kind: "PARTNER",
        legalName: optionalText(input.legalName, "legalName", 200) ?? null, gstin: gstin(input.gstin) ?? null,
        address: address(input.address), contacts: contacts(input.contacts), logoUrl: logoUrl(input.logoUrl) ?? null
      },
      select: PARTNER_FIELDS
    }).catch((error) => conflict(error, "A partner with this slug already exists"));
    admin.audit = { tenantId: partner.id, resourceType: "Tenant", resourceId: partner.id };
    return partner;
  }

  async get(partnerId: string) {
    const partner = await this.prisma.tenant.findUnique({ where: { id: partnerId }, select: { ...PARTNER_FIELDS, clients: { select: PROGRAM_FIELDS, orderBy: { createdAt: "asc" } } } });
    if (!partner) throw new NotFoundException("Partner not found");
    const { clients, ...rest } = partner;
    return { ...rest, programs: clients };
  }

  async update(admin: AdminContext, partnerId: string, input: PartnerInput) {
    await this.get(partnerId);
    if (input.slug !== undefined) throw new BadRequestException("slug cannot be changed");
    const partner = await this.prisma.tenant.update({
      where: { id: partnerId },
      data: {
        name: input.name === undefined ? undefined : text(input.name, "name"),
        legalName: optionalText(input.legalName, "legalName", 200), gstin: gstin(input.gstin),
        address: address(input.address), contacts: contacts(input.contacts), logoUrl: logoUrl(input.logoUrl)
      },
      select: PARTNER_FIELDS
    });
    admin.audit = { tenantId: partnerId, resourceType: "Tenant", resourceId: partnerId };
    return partner;
  }

  /** A disabled partner's keys, staff and admin panel scope stop working at once (guards check status). */
  async setStatus(admin: AdminContext, partnerId: string, status: "ACTIVE" | "DISABLED") {
    const partner = await this.get(partnerId);
    if (partner.kind === "DIRECT" && status === "DISABLED") throw new BadRequestException("Liwip Direct cannot be disabled");
    const updated = await this.prisma.tenant.update({ where: { id: partnerId }, data: { status, disabledAt: status === "DISABLED" ? new Date() : null }, select: PARTNER_FIELDS });
    admin.audit = { tenantId: partnerId, resourceType: "Tenant", resourceId: partnerId, metadata: { status } };
    return updated;
  }

  async createProgram(admin: AdminContext, partnerId: string, input: ProgramInput) {
    await this.get(partnerId);
    const code = text(input.code, "code", 80).toUpperCase();
    if (!PROGRAM_CODE.test(code)) throw new BadRequestException("code must be uppercase letters, digits, _ or -");
    const program = await this.prisma.client.create({
      data: { id: `client_${randomUUID()}`, tenantId: partnerId, code, name: text(input.name, "name"), corporateCode: corporateCode(input.corporateCode) ?? null, description: optionalText(input.description, "description", 500) ?? null },
      select: PROGRAM_FIELDS
    }).catch((error) => conflict(error, "This program code or corporate code is already in use"));
    admin.audit = { tenantId: partnerId, clientId: program.id, resourceType: "Client", resourceId: program.id };
    return program;
  }

  async updateProgram(admin: AdminContext, partnerId: string, programId: string, input: ProgramInput) {
    if (input.code !== undefined) throw new BadRequestException("code cannot be changed");
    const existing = await this.prisma.client.findFirst({ where: { id: programId, tenantId: partnerId } });
    if (!existing) throw new NotFoundException("Program not found");
    const program = await this.prisma.client.update({
      where: { id: programId },
      data: { name: input.name === undefined ? undefined : text(input.name, "name"), corporateCode: corporateCode(input.corporateCode), description: optionalText(input.description, "description", 500) },
      select: PROGRAM_FIELDS
    }).catch((error) => conflict(error, "This corporate code is already in use"));
    admin.audit = { tenantId: partnerId, clientId: programId, resourceType: "Client", resourceId: programId };
    return program;
  }

  async setProgramStatus(admin: AdminContext, partnerId: string, programId: string, status: "ACTIVE" | "DISABLED") {
    const changed = await this.prisma.client.updateMany({ where: { id: programId, tenantId: partnerId }, data: { status, disabledAt: status === "DISABLED" ? new Date() : null } });
    if (!changed.count) throw new NotFoundException("Program not found");
    admin.audit = { tenantId: partnerId, clientId: programId, resourceType: "Client", resourceId: programId, metadata: { status } };
    return this.prisma.client.findUniqueOrThrow({ where: { id: programId }, select: PROGRAM_FIELDS });
  }

  /** The partner's own company profile and programs, for partner staff (scoped client). */
  async organisation(admin: AdminContext) {
    const db = partnerDb(this.prisma, admin);
    const [partner, programs] = await Promise.all([
      db.tenant.findFirst({ select: PARTNER_FIELDS }),
      db.client.findMany({ select: PROGRAM_FIELDS, orderBy: { createdAt: "asc" } })
    ]);
    if (!partner) throw new NotFoundException("Partner not found");
    return { ...partner, programs };
  }

  // --- Vendors (GLOBAL) ---

  async listVendors(page: Page) {
    const [items, total] = await Promise.all([
      this.prisma.vendor.findMany({ orderBy: { createdAt: "desc" }, skip: page.skip, take: page.limit }),
      this.prisma.vendor.count()
    ]);
    return paginated(items, total, page);
  }

  async createVendor(admin: AdminContext, input: { slug?: unknown; name?: unknown; contacts?: unknown }) {
    const slug = text(input.slug, "slug", 80).toLowerCase();
    if (!SLUG.test(slug)) throw new BadRequestException("slug must be lowercase letters, digits, _ or -");
    const vendor = await this.prisma.vendor.create({ data: { id: `vendor_${randomUUID()}`, slug, name: text(input.name, "name"), contacts: contacts(input.contacts) } })
      .catch((error) => conflict(error, "A vendor with this slug already exists"));
    admin.audit = { resourceType: "Vendor", resourceId: vendor.id };
    return vendor;
  }

  async vendor(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException("Vendor not found");
    return vendor;
  }

  async setVendorStatus(admin: AdminContext, vendorId: string, status: "ACTIVE" | "DISABLED") {
    await this.vendor(vendorId);
    admin.audit = { resourceType: "Vendor", resourceId: vendorId, metadata: { status } };
    return this.prisma.vendor.update({ where: { id: vendorId }, data: { status } });
  }
}
