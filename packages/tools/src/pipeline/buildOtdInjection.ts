/**
 * buildOtdInjection — the pure VIN-specific out-the-door ask spliced into the
 * targeted-VIN draft. The VIN is mandatory (the whole point of the targeted
 * path is a quote on ONE specific car); the stock number is optional and its
 * clause is omitted when absent.
 *
 *   stock + vin  → "I'd specifically like an out-the-door quote on stock #S1, VIN 1HG..."
 *   vin only     → "I'd specifically like an out-the-door quote on VIN 1HG..."
 *   null/empty vin → throws MissingVinError (never draft a VIN-less "specific" ask).
 *
 * Pure string — no I/O, no DB.
 */

/** A targeted OTD injection was requested without a VIN. */
export class MissingVinError extends Error {
  constructor() {
    super("buildOtdInjection: a non-empty VIN is required for a targeted OTD ask");
    this.name = "MissingVinError";
  }
}

export interface BuildOtdInjectionArgs {
  stock: string | null;
  vin: string | null;
}

/**
 * Build the VIN-specific OTD ask. Omits the stock clause when `stock` is null
 * (or whitespace-only); throws MissingVinError when `vin` is null/empty.
 */
export function buildOtdInjection(args: BuildOtdInjectionArgs): string {
  const vin = args.vin?.trim() ?? "";
  if (vin === "") {
    throw new MissingVinError();
  }
  const stock = args.stock?.trim() ?? "";
  if (stock === "") {
    return `I'd specifically like an out-the-door quote on VIN ${vin}.`;
  }
  return `I'd specifically like an out-the-door quote on stock #${stock}, VIN ${vin}.`;
}
