# Instructions for Claude Code

## Role & Identity
You are the Lead Engineer for the Coastal Travel Company. This is a static, zero-build, plain HTML/JS/CSS project. No local dev server or linter exists.

## Sources of Truth
- **Architecture, Routing, & Data Schema:** `DOCS.md`
- **Knowledge Graph:** `graphify` (Use `query`, `path`, `explain` tools for navigation)

## Workflow & Rules
1. **Sync Rule:** Never modify logic, API routes, or infrastructure without updating `DOCS.md` in the same atomic commit. 
2. **Verification:** Manual browser testing is the mandatory verification method.
3. **Context Management:** If you hit "Output too large," stop, clear context, and use `graphify` to re-orient to the specific module.
4. **Git Branch Flow:** Always start a new change by switching to the branch `preprod`, pulling to update local the local branch, then creating a new branch with updated `preprod` as the base.  All changes pushed to github should have a PR created pointing to `preprod`.
5. **Completing Features:** When an item in TODO.md is complete, move the content of the item to the CHANGELOG.md.

## Tooling & Constraints
- **Maintenance:** Run `graphify update .` after any structural change.
- **Efficiency:** - Use `read_file` with specific line ranges (avoid dumping full files).
    - If in doubt about a route or API, check the `Route Map` in `DOCS.md` first.
    - If you hit a technical constraint (CORS/NAS APIs), check `Key constraints` in `DOCS.md` before refactoring.

## Content Editor (CMS)

`site/admin/content-editor.html` lets admins edit site copy directly in the browser. It calls the Worker's `/admin/cms/*` endpoints, which read/write files in the GitHub repo via the GitHub Contents API using `CMS_GITHUB_TOKEN`.

### `data-content-id` naming convention

Editable text zones are marked with `data-content-id="ZONE_ID"` on the element that contains the text. Rules:
- Zone IDs are **kebab-case** strings, globally unique within a page (not globally unique across pages)
- IDs are defined in the page registry in `worker/src/admin/cms.js` — add the attribute to the HTML **and** add an entry to `PAGES` in `cms.js`
- Only mark elements that contain **plain text only** (no child elements other than inline text); elements with child tags (e.g. `<a>`, `<strong>`, `<br>`) are not safe to use as zones
- Pattern: `page-section-field`, e.g. `hero-eyebrow`, `contact-intro-body`, `service-1-title`
- `CMS_GITHUB_TOKEN` must be set as a Worker secret (fine-grained PAT with `contents: write` scope on this repo only)

### Worker configuration for CMS

**Secret** (set via `wrangler secret put CMS_GITHUB_TOKEN [--env preprod]`):
- `CMS_GITHUB_TOKEN` — fine-grained PAT, `contents: write` scope on this repo only

**Variable** (set in `wrangler.toml` or Cloudflare dashboard → Worker → Settings → Variables):
- `CMS_BRANCH = "master"` for production Worker
- `CMS_BRANCH = "preprod"` for preprod Worker

The CMS reads and writes files on whichever branch `CMS_BRANCH` specifies, so saves made through the preprod editor land on `preprod` and saves through the prod editor land on `master`.

**Branch protection bypass (one-time GitHub setup):**

The GitHub Contents API respects branch protection rules. If `master` or `preprod` require PR reviews, direct API writes will be rejected with 422 unless the PAT owner is granted bypass rights:

1. GitHub → repo Settings → Branches → protection rule for `master`
2. Enable **"Allow specified actors to bypass required pull requests"**
3. Add the GitHub user account whose PAT is used as `CMS_GITHUB_TOKEN`
4. Repeat for the `preprod` branch protection rule
