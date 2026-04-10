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
 * Neutral activity shape for parity assertions. Only the fields the
 * contract test cares about — we deliberately drop timestamps
 * (`createdAt`, `claimedAt`), server-assigned IDs, and Flask-only OCC
 * concepts like `version`/`bounty_id` because they diverge by design.
 *
 * `dueDate` is a plain YYYY-MM-DD string so Flask's ISO date and
 * Firebase's Timestamp collapse to the same representation without
 * timezone surprises.
 */
export interface NormalizedActivity {
  title: string;
  type: "ALLOWANCE" | "BOUNTY_RECURRING" | "INTEREST";
  status: "LOCKED" | "READY";
  rewardCents: number;
  dueDate: string;
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
  if (!Number.isFinite(dollars)) {
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

function assertActivityType(
  value: unknown,
  source: string,
): "ALLOWANCE" | "BOUNTY_RECURRING" | "INTEREST" {
  if (value === "ALLOWANCE" || value === "BOUNTY_RECURRING" || value === "INTEREST") {
    return value;
  }
  throw new TypeError(`${source}: bad activity type: ${String(value)}`);
}

function assertActivityStatus(
  value: unknown,
  source: string,
): "LOCKED" | "READY" {
  if (value === "LOCKED" || value === "READY") {
    return value;
  }
  throw new TypeError(`${source}: bad activity status: ${String(value)}`);
}

/**
 * Normalize a Flask activity `to_dict()` into the shared shape.
 * Flask's wire names are `card_type`, `description`, `amount`,
 * `due_date`; amounts are dollars-as-float and `due_date` is already
 * a YYYY-MM-DD ISO string (see `Activity.to_dict` in the Flask
 * repo), so no transformation needed beyond dollars→cents.
 */
export function normalizeFlaskActivity(raw: unknown): NormalizedActivity {
  const obj = raw as {
    card_type?: unknown;
    status?: unknown;
    amount?: unknown;
    description?: unknown;
    due_date?: unknown;
  };
  if (typeof obj.description !== "string") {
    throw new TypeError(
      `normalizeFlaskActivity: missing description: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj.amount !== "number") {
    throw new TypeError(
      `normalizeFlaskActivity: missing/invalid amount: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj.due_date !== "string") {
    throw new TypeError(
      `normalizeFlaskActivity: missing due_date: ${JSON.stringify(raw)}`,
    );
  }
  return {
    title: obj.description,
    type: assertActivityType(obj.card_type, "normalizeFlaskActivity"),
    status: assertActivityStatus(obj.status, "normalizeFlaskActivity"),
    rewardCents: centsFromDollars(obj.amount),
    dueDate: obj.due_date,
  };
}

/**
 * Normalize a Firebase activity doc. Firestore stores the canonical
 * shape (`title`, `reward` in cents, `type`, `status`, `dueDate`
 * Timestamp). `dueDate` lands as a Firestore Timestamp via the client
 * SDK, so we convert to YYYY-MM-DD in UTC to match Flask's
 * `date.isoformat()` output.
 */
export function normalizeFirebaseActivity(raw: unknown): NormalizedActivity {
  const obj = raw as {
    title?: unknown;
    type?: unknown;
    status?: unknown;
    reward?: unknown;
    dueDate?: unknown;
  };
  if (typeof obj.title !== "string") {
    throw new TypeError(
      `normalizeFirebaseActivity: missing title: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj.reward !== "number") {
    throw new TypeError(
      `normalizeFirebaseActivity: missing/invalid reward: ${JSON.stringify(raw)}`,
    );
  }
  return {
    title: obj.title,
    type: assertActivityType(obj.type, "normalizeFirebaseActivity"),
    status: assertActivityStatus(obj.status, "normalizeFirebaseActivity"),
    rewardCents: obj.reward,
    dueDate: extractDueDate(obj.dueDate),
  };
}

/**
 * The client SDK returns `dueDate` as a Firestore Timestamp (has
 * `.toDate()`) when the field was written via `Timestamp.fromDate`.
 * Handle that plus a stringy fallback just in case a test writes a
 * raw string. UTC slice of `toISOString()` gives YYYY-MM-DD.
 */
function extractDueDate(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    const d = (value as { toDate: () => Date }).toDate();
    return d.toISOString().slice(0, 10);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    // Already YYYY-MM-DD — common when tests assign a literal.
    return value.slice(0, 10);
  }
  throw new TypeError(
    `normalizeFirebaseActivity: missing/invalid dueDate: ${String(value)}`,
  );
}
