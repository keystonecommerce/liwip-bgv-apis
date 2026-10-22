/**
 * The two BGV modules. People: identity, address, court, employment and the rest. Vehicle: the
 * vehicle's own records (RC, challans; insurance, PUC, fitness and permit as they are added).
 * A case can be for a person, a vehicle, or both (a driver with their vehicle).
 */
export const BGV_MODULES = ["PEOPLE", "VEHICLE"] as const;
export type BgvModule = (typeof BGV_MODULES)[number];

export const VEHICLE_CHECK_TYPES = ["RC_FULL", "RC_V2", "VEHICLE_CHALLAN"] as const;

const VEHICLE = new Set<string>(VEHICLE_CHECK_TYPES);

export const moduleOf = (type: string): BgvModule => (VEHICLE.has(type) ? "VEHICLE" : "PEOPLE");

/** The modules a set of checks covers, People first. */
export function modulesOf(types: Iterable<string>): BgvModule[] {
  const found = new Set([...types].map(moduleOf));
  return BGV_MODULES.filter((module) => found.has(module));
}

/** Who or what the case verifies: the person and, with vehicle checks, the vehicle by its number. */
export function subjectOf(types: Iterable<string>, data: unknown) {
  const modules = modulesOf(types);
  const vehicle = (data as { vehicle?: { registrationNumber?: unknown } } | null)?.vehicle;
  const registrationNumber = typeof vehicle?.registrationNumber === "string" && vehicle.registrationNumber ? vehicle.registrationNumber : null;
  return {
    person: modules.includes("PEOPLE"),
    vehicle: modules.includes("VEHICLE") ? { registrationNumber } : null
  };
}
