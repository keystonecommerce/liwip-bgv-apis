import { BadRequestException } from "@nestjs/common";

/** Small input checks for admin panel bodies and queries (plain objects, like the rest of this API). */
export function text(value: unknown, label: string, max = 120, min = 1): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new BadRequestException(`${label} must be ${min} to ${max} characters`);
  return value.trim();
}

export function optionalText(value: unknown, label: string, max = 200): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return text(value, label, max);
}

export function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const upper = String(value ?? "").trim().toUpperCase();
  if (!allowed.includes(upper as T)) throw new BadRequestException(`${label} must be one of ${allowed.join(", ")}`);
  return upper as T;
}

export function optionalDate(value: unknown, label: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} must be a date`);
  return date;
}

export const ID = /^[A-Za-z0-9_-]{1,100}$/;
export function id(value: unknown, label: string): string {
  const candidate = String(value ?? "").trim();
  if (!ID.test(candidate)) throw new BadRequestException(`${label} is not valid`);
  return candidate;
}

export interface Page { page: number; limit: number; skip: number }

/** ?page=1&limit=20 (limit up to 100). */
export function pageOf(query: { page?: string; limit?: string }): Page {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new BadRequestException("page must be a positive integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException("limit must be an integer from 1 to 100");
  return { page, limit, skip: (page - 1) * limit };
}

/** The list shape every admin panel list returns: { items, meta: { total, page, limit, totalPages } }. */
export function paginated<T>(items: T[], total: number, page: Page) {
  return { items, meta: { total, page: page.page, limit: page.limit, totalPages: Math.ceil(total / page.limit) } };
}

/** Masks a 91XXXXXXXXXX phone to its last four digits. */
export const maskPhone = (phone: string | null | undefined) => (phone && /^91\d{10}$/.test(phone) ? `******${phone.slice(-4)}` : null);
