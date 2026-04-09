/**
 * Vitest globalSetup for the contract test run.
 *
 * Runs once per `vitest run test/contract` invocation, before any
 * test file loads. Its job is to bring up the Flask + Postgres
 * docker-compose stack and leave a teardown behind so it gets torn
 * down at the end of the run.
 *
 * The Firebase side (Firestore + Auth emulators + onTransactionCreate
 * function emulator) is NOT started here — that's handled by the
 * outer `scripts/run-contract-tests.sh` wrapper which runs us
 * inside `firebase emulators:exec`. Splitting the two lifecycles
 * keeps this file small and lets us debug Flask boot issues without
 * also waiting for the Java emulator startup.
 *
 * If the Flask repo isn't available, `bootFlask()` throws a
 * descriptive error and vitest surfaces it as a setup failure —
 * the test files never load, so we don't waste time running
 * assertions that can't succeed.
 */

import { bootFlask, type FlaskHandle } from "./bootFlask";

let handle: FlaskHandle | null = null;

export async function setup(): Promise<void> {
  handle = await bootFlask();
}

export async function teardown(): Promise<void> {
  if (handle) {
    await handle.teardown();
    handle = null;
  }
}
