/**
 * Wire-format normalisation between Flask and Firebase.
 *
 * The two backends use different on-wire shapes for the same
 * conceptual data. The contract tests need to assert parity, so
 * before comparing a Flask response to a Firebase response both
 * sides get flattened into a single neutral shape:
 *
 *   NormalizedChild       — `{ name, balanceCents }`
 *   NormalizedTransaction — `{ type, amountCents, description }`
 *
 * Key translation:
 *
 * - **Money.** Flask is Numeric(10,2) dollars-as-float on the wire
 *   (e.g. `10.50` means ten dollars fifty). Firebase stores and
 *   returns integer cents (e.g. `1050`). The conversion direction
 *   is always Flask→cents via `centsFromDollars`. Never the reverse
 *   — we never want to round-trip cents back to float for an
 *   assertion because float arithmetic would introduce noise.
 *
 * - **Field naming.** Flask uses snake_case (`created_at`,
 *   `date_of_birth`); Firebase uses camelCase. The normalized
 *   shape is strictly the subset of fields the contract tests
 *   care about, so we don't fight with every field.
 *
 * - **IDs.** Neither backend guarantees the other's IDs, so
 *   `id` is deliberately absent from the normalized shape.
 *   Assertions compare state (balance, description, type, count),
 *   not identity.
 */

export interface NormalizedChild {
  name: string;
  balanceCents: number;
}

export interface NormalizedTransaction {
  type: "LODGE" | "WITHDRAW";
  amountCents: number;
  description: string;
}

/**
 * Convert a Flask dollars-as-float money value to integer cents.
 *
 * Round to the nearest cent to absorb float representation noise
 * (`10.1 * 100` is `1009.9999...` in IEEE-754). The Flask side
 * stores `Numeric(10,2)` so the input is always semantically a
 * 2-decimal value; `Math.round` is sufficient.
 */
export function centsFromDollars(dollars: number): number {
  if (typeof dollars !== "number" || Number.isNaN(dollars)) {
    throw new TypeError(
      `centsFromDollars: expected finite number, got ${typeof dollars}: ${String(dollars)}`,
    );
  }
  return Math.round(dollars * 100);
}

/**
 * Normalize a Flask child response. Flask returns a flat object:
 *
 *   { id, name, date_of_birth, balance: <float>, profile_image_url,
 *     created_at, parent_id }
 *
 * We only care about name + balance for parity assertions.
 */
export function normalizeFlaskChild(raw: unknown): NormalizedChild {
  const obj = raw as { name?: unknown; balance?: unknown };
  if (typeof obj.name !== "string") {
    throw new TypeError(`normalizeFlaskChild: missing/invalid name: ${JSON.stringify(raw)}`);
  }
  if (typeof obj.balance !== "number") {
    throw new TypeError(`normalizeFlaskChild: missing/invalid balance: ${JSON.stringify(raw)}`);
  }
  return {
    name: obj.name,
    balanceCents: centsFromDollars(obj.balance),
  };
}

/**
 * Normalize a Firebase child document. The client SDK returns the
 * raw Firestore data (already in cents).
 */
export function normalizeFirebaseChild(raw: unknown): NormalizedChild {
  const obj = raw as { name?: unknown; balance?: unknown };
  if (typeof obj.name !== "string") {
    throw new TypeError(
      `normalizeFirebaseChild: missing/invalid name: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj.balance !== "number") {
    throw new TypeError(
      `normalizeFirebaseChild: missing/invalid balance: ${JSON.stringify(raw)}`,
    );
  }
  return {
    name: obj.name,
    balanceCents: obj.balance,
  };
}

/**
 * Normalize a Flask transaction response. Flask wraps the created
 * transaction in `{ transaction: {...}, new_balance: <float> }`;
 * this helper expects the inner transaction object.
 */
export function normalizeFlaskTransaction(raw: unknown): NormalizedTransaction {
  const obj = raw as {
    type?: unknown;
    amount?: unknown;
    description?: unknown;
  };
  if (obj.type !== "LODGE" && obj.type !== "WITHDRAW") {
    throw new TypeError(
      `normalizeFlaskTransaction: bad type: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj.amount !== "number") {
    throw new TypeError(
      `normalizeFlaskTransaction: bad amount: ${JSON.stringify(raw)}`,
    );
  }
  return {
    type: obj.type,
    amountCents: centsFromDollars(obj.amount),
    description: typeof obj.description === "string" ? obj.description : "",
  };
}

/**
 * Normalize a Firebase transaction document.
 */
export function normalizeFirebaseTransaction(raw: unknown): NormalizedTransaction {
  const obj = raw as {
    type?: unknown;
    amount?: unknown;
    description?: unknown;
  };
  if (obj.type !== "LODGE" && obj.type !== "WITHDRAW") {
    throw new TypeError(
      `normalizeFirebaseTransaction: bad type: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj.amount !== "number") {
    throw new TypeError(
      `normalizeFirebaseTransaction: bad amount: ${JSON.stringify(raw)}`,
    );
  }
  return {
    type: obj.type,
    amountCents: obj.amount,
    description: typeof obj.description === "string" ? obj.description : "",
  };
}
