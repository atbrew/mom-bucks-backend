/**
 * Boot the Flask + Postgres stack for a contract-test run.
 *
 * Strategy: we layer two docker-compose files.
 *
 *   1. `$MOM_BUCKS_REPO_PATH/integration-tests/docker-compose.test.yml`
 *      — the Flask repo's own test compose (builds the Flask image
 *      from `../web-app`, starts an ephemeral Postgres, exposes the
 *      API on port 5011).
 *
 *   2. `functions/test/contract/docker-compose.override.yml`
 *      — owned by this repo. Its only job is to append
 *      `TEST_AUTH_BYPASS_ENABLED=1` to the api service environment,
 *      which flips the Flask test-auth shim on without requiring any
 *      modification to the Flask repo.
 *
 * This separation matters: CLAUDE.md explicitly forbids modifying
 * Flask code from this repo, and putting the env toggle in an
 * override file keeps us on the right side of that rule.
 *
 * Lifecycle is owned by a vitest `globalSetup` entry in
 * `vitest.contract.config.ts`:
 *   - setup(): spawn `docker compose up -d --wait`, poll `/health`
 *     until it returns 200, return teardown()
 *   - teardown(): `docker compose down -v` to blow away the
 *     ephemeral Postgres volume
 *
 * If `$MOM_BUCKS_REPO_PATH` is unset, default to `~/Development/mom-bucks`
 * (the user's standard layout). If the path doesn't exist or doesn't
 * contain the expected compose file, fail fast with a clear message
 * so nobody wastes time debugging a cryptic docker error.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

/** Host port the Flask compose exposes the API on. See docker-compose.test.yml. */
export const FLASK_API_PORT = 5011;

/** Base URL test clients should hit the Flask API at. */
export const FLASK_BASE_URL = `http://localhost:${FLASK_API_PORT}`;

/** How long we wait for `/health` to go green before giving up. */
const HEALTH_CHECK_TIMEOUT_MS = 120_000;

/** Poll interval while waiting for health. */
const HEALTH_CHECK_INTERVAL_MS = 1_000;

/**
 * Resolve the Flask repo path and sanity-check it.
 *
 * Returns the absolute path if the repo looks right, throws a
 * descriptive error otherwise. The check is deliberately narrow —
 * existence of the test compose file is enough evidence that the
 * user has the right thing checked out.
 */
export function resolveFlaskRepoPath(): string {
  const envValue = process.env.MOM_BUCKS_REPO_PATH;
  const candidate = envValue
    ? resolve(envValue)
    : resolve(join(homedir(), "Development", "mom-bucks"));
  const composePath = join(candidate, "integration-tests", "docker-compose.test.yml");
  if (!existsSync(composePath)) {
    throw new Error(
      [
        `Contract tests need the Flask repo at \`${candidate}\`,`,
        `but \`${composePath}\` does not exist.`,
        "",
        "Either:",
        "  1. Clone atbrew/mom-bucks to ~/Development/mom-bucks, or",
        "  2. Set MOM_BUCKS_REPO_PATH to its location.",
      ].join("\n"),
    );
  }
  return candidate;
}

/** Arguments common to every `docker compose` invocation — the two `-f` layers + the project name. */
function composeArgs(flaskRepo: string): string[] {
  const flaskCompose = join(flaskRepo, "integration-tests", "docker-compose.test.yml");
  const overrideCompose = resolve(__dirname, "..", "docker-compose.override.yml");
  return [
    "compose",
    "-f",
    flaskCompose,
    "-f",
    overrideCompose,
    "-p",
    "mombucks_contract",
  ];
}

/** Run `docker compose ...` and resolve/reject on exit. stdout/stderr stream to the parent. */
function runCompose(
  flaskRepo: string,
  subArgs: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [...composeArgs(flaskRepo), ...subArgs];
    const child = spawn("docker", args, { stdio: "inherit" });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(
        new Error(
          `docker ${args.join(" ")} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`docker ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

/**
 * Poll `GET /health` until it returns 200 or we hit the timeout.
 *
 * We do this on top of `docker compose up --wait` (which waits for
 * the container healthcheck) because --wait can return before Flask
 * has finished its boot-time DB migrations under heavy CI load. One
 * extra second of belt-and-braces polling avoids flake.
 */
async function waitForHealth(): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < HEALTH_CHECK_TIMEOUT_MS) {
    try {
      const res = await fetch(`${FLASK_BASE_URL}/health`);
      if (res.ok) return;
      lastErr = new Error(`/health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }
  throw new Error(
    `Flask /health did not come up within ${HEALTH_CHECK_TIMEOUT_MS}ms: ${String(lastErr)}`,
  );
}

export interface FlaskHandle {
  /** Tear the compose stack down. Safe to call multiple times. */
  teardown(): Promise<void>;
}

/**
 * Boot the Flask stack and wait for it to be reachable.
 *
 * Called from vitest `globalSetup`. The returned handle's
 * `teardown()` runs from `globalTeardown`.
 */
export async function bootFlask(): Promise<FlaskHandle> {
  const flaskRepo = resolveFlaskRepoPath();

  // `--wait` blocks until healthchecks pass; `--build` picks up any
  // Flask code changes since the last run. `--remove-orphans` cleans
  // up any containers left over from a prior aborted run of an older
  // compose file.
  await runCompose(
    flaskRepo,
    ["up", "-d", "--wait", "--build", "--remove-orphans"],
    300_000,
  );
  await waitForHealth();

  let torn = false;
  return {
    async teardown() {
      if (torn) return;
      torn = true;
      // `-v` drops the ephemeral Postgres volume so the next run
      // starts from a fresh DB with no leftover users or children.
      await runCompose(flaskRepo, ["down", "-v"], 120_000);
    },
  };
}
