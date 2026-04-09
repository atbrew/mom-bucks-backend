/**
 * Vitest config for the contract test suite.
 *
 * This config is separate from the main `vitest.config.ts` because
 * contract tests have very different operational requirements from
 * unit tests:
 *
 *   - They boot Flask via docker-compose (globalSetup/teardown).
 *   - They need to run inside `firebase emulators:exec` so the
 *     Firestore + Auth emulators are reachable.
 *   - Individual tests are much slower (network I/O, emulator
 *     writes, trigger propagation) so the default timeout needs
 *     to be higher.
 *   - They must NOT run as part of `npm test` — that command is the
 *     fast inner-loop path developers hit every save, and contract
 *     tests would turn it into a minute-long ordeal.
 *
 * To run locally:
 *   cd functions && npm run test:contract
 *
 * The `test:contract` script wraps this config in the emulator
 * orchestration shell script. See `scripts/run-contract-tests.sh`.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/contract/**/*.contract.test.ts"],
    // globalSetup exposes setup()/teardown() on a single module.
    globalSetup: ["./test/contract/harness/globalSetup.ts"],
    // Each test can talk to the Flask API + Firestore emulator +
    // wait for a trigger to fire; 30s gives generous headroom
    // without letting a real hang drag forever.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Serial execution: the docker-compose stack and emulator state
    // are shared across tests, so parallel workers would race each
    // other's writes. The test count is small enough that serial is
    // fine.
    fileParallelism: false,
    environment: "node",
  },
});
