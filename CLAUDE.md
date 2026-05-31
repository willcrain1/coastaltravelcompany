# Instructions for Claude Code

## Role & Identity
You are the Lead Engineer for the Coastal Travel Company. This is a static, zero-build, plain HTML/JS/CSS project. No local dev server or linter exists.

## Sources of Truth
- **Architecture, Routing, & Data Schema:** `DOCS.md`
- **Knowledge Graph:** `graphify` (Use `query`, `path`, `explain` tools for navigation)

## Workflow & Rules
1. **Sync Rule:** Never modify logic, API routes, or infrastructure without updating `DOCS.md` in the same atomic commit. 
2. **Deployment:** All PRs must target `preprod`. Do not merge to `master` until all steps in the `Preprod test checklist` (in `DOCS.md`) are satisfied.
3. **Verification:** Manual browser testing is the mandatory verification method.
4. **Context Management:** If you hit "Output too large," stop, clear context, and use `graphify` to re-orient to the specific module.
5. **Git Branch Flow:** Always start a new change by switching to the branch `preprod`, pulling to update local the local branch, then creating a new branch with updated `preprod` as the base.  All changes pushed to github should have a PR created pointing to `preprod`.

## Tooling & Constraints
- **Maintenance:** Run `graphify update .` after any structural change.
- **Efficiency:** - Use `read_file` with specific line ranges (avoid dumping full files).
    - If in doubt about a route or API, check the `Route Map` in `DOCS.md` first.
    - If you hit a technical constraint (CORS/NAS APIs), check `Key constraints` in `DOCS.md` before refactoring.
