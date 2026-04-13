# Release

Cut a production release — bump version, trigger the deploy-prod workflow, monitor results.

## Steps

1. **Determine current version:**
   - Check latest Git tag: `git tag --sort=-v:refname | head -1`
   - If no tags exist, assume `v0.0.0`

2. **Ask the user which bump type:**
   Present clearly:
   ```
   Current version: vX.Y.Z

   What type of release?
   1. Patch  (vX.Y.Z+1) — bug fixes, small tweaks
   2. Minor  (vX.Y+1.0) — new features, milestone
   3. Major  (vX+1.0.0) — breaking changes, major release
   ```
   Wait for the user to respond with 1, 2, 3, "patch", "minor", or "major".

3. **Calculate new version:**
   - Patch: increment Z
   - Minor: increment Y, reset Z to 0
   - Major: increment X, reset Y and Z to 0

4. **Confirm with the user:**
   ```
   Ready to release vX.Y.Z?
   This will:
   - Run CI gate (lint, typecheck, build, unit tests, rules tests)
   - Deploy functions, rules, indexes, storage, and hosting to prod
   - Run smoke test against prod
   - Tag the commit as vX.Y.Z
   Proceed? (yes/no)
   ```

5. **Trigger the deploy-prod workflow:**
   ```bash
   gh workflow run deploy-prod.yml -f version=vX.Y.Z --repo atbrew/mom-bucks-backend
   ```

6. **Monitor the workflow:**
   - Poll `gh run list --workflow=deploy-prod.yml --limit=1` every 30 seconds
   - Report status updates at key milestones (CI gate passing, deploy starting, smoke test running)
   - If any job fails, report immediately with the failure details

7. **On success:**
   - Confirm the tag was created: `gh api repos/atbrew/mom-bucks-backend/git/refs/tags/vX.Y.Z`
   - Report:
     ```
     Release vX.Y.Z complete!
     - Firebase deployed to prod (functions, rules, hosting)
     - Smoke test passed
     - Tagged as vX.Y.Z
     ```

8. **On failure:**
   - Report which job failed and link to the workflow run
   - Suggest next steps (check logs, fix and retry)
