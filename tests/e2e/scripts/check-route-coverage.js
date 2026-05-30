#!/usr/bin/env node
/**
 * Router-based e2e coverage enforcement (item 43).
 *
 * Parses worker/src/router.js to extract every route pattern, then checks
 * that each one is referenced in at least one Playwright spec file or appears
 * in the explicit allowlist. Exits non-zero if uncovered routes are found.
 *
 * Usage:
 *   node tests/e2e/scripts/check-route-coverage.js
 *
 * Routes may be covered by:
 *   a) A literal path string in a spec file  (e.g. '/admin/walkthroughs')
 *   b) A path-building expression            (e.g. `/admin/projects/${id}`)
 *   c) An annotation comment                 (// covers: POST /stripe/webhook)
 *   d) The ALLOWLIST below for routes tested via other means
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '../../..');

// Routes excluded from the spec-file reference requirement.
// Each entry must have a reason documenting WHY it is exempt.
const ALLOWLIST = new Set([
  // Tested via Stripe CLI trigger in preprod, not via Playwright page interaction
  'POST /stripe/webhook',
  // NAS proxy fallthrough — exercised by gallery.spec.js SID requests indirectly
  'GET /nas-proxy',
  // POST /token is tested in gallery.spec.js as part of the gallery unlock flow
  'POST /token',
  // Public schedule uses a magic token from DB — covered by schedule.spec.js
  'GET /schedule/:id',
  'POST /schedule/:id',
  // Public questionnaire covered by questionnaire.spec.js
  'GET /questionnaire/:id',
  'POST /questionnaire/:id',
  // Public portal project covered by portal-project.spec.js
  'GET /portal/project/:id',
  'POST /portal/project/:id',
  // Public availability endpoint — availability calendar removed from contact page;
  // endpoint is covered by worker unit tests (scheduling.test.js)
  'GET /public/availability',
]);

// ── Step 1: Extract routes from router.js ─────────────────────────────────────

const routerSrc = readFileSync(join(ROOT, 'worker/src/router.js'), 'utf8');
const lines     = routerSrc.split('\n');

const routes = [];

for (const line of lines) {
  // Match: method === 'GET' && pathname === '/some/path'
  const simpleMatch = line.match(/method\s*===\s*'(\w+)'.*pathname\s*===\s*'(\/[^']+)'/);
  if (simpleMatch) {
    routes.push({ method: simpleMatch[1], path: simpleMatch[2] });
    continue;
  }

  // Match: pathname.match(/^\/some\/path\/.../)
  const matchExpr = line.match(/pathname\.match\(\/\^((?:\\.|[^/])+)\/\)/);
  if (matchExpr) {
    // Convert regex to a human-readable path pattern
    const pattern = matchExpr[1]
      .replace(/\\\//g, '/')
      .replace(/\(\[\^\/\]\+\)/g, ':id')
      .replace(/\$/, '')
      .replace(/\\/g, '');

    // Extract methods from surrounding context
    const methodMatches = [...line.matchAll(/method\s*===\s*'(\w+)'/g)];
    if (methodMatches.length) {
      for (const m of methodMatches) {
        routes.push({ method: m[1], path: pattern });
      }
    } else {
      // Method checked elsewhere — add a wildcard entry
      routes.push({ method: '*', path: pattern });
    }
    continue;
  }

  // Match: pathname === '/admin/...' without method check (method checked inside handler)
  const pathnameOnly = line.match(/pathname\s*===\s*'(\/[^']+)'/);
  if (pathnameOnly && !line.includes('method')) {
    routes.push({ method: '*', path: pathnameOnly[1] });
  }
}

// De-duplicate
const unique = [...new Map(routes.map(r => [`${r.method} ${r.path}`, r])).values()];

// ── Step 2: Build a search corpus from all spec files ─────────────────────────

const specDir  = join(ROOT, 'tests/e2e');
const specFiles = readdirSync(specDir)
  .filter(f => f.endsWith('.spec.js'))
  .map(f => readFileSync(join(specDir, f), 'utf8'));
const allSpecText = specFiles.join('\n');

// ── Step 3: Check coverage ────────────────────────────────────────────────────

const uncovered = [];

for (const { method, path } of unique) {
  const key = `${method} ${path}`;

  // Check allowlist
  if (ALLOWLIST.has(key) || ALLOWLIST.has(`* ${path}`)) continue;

  // Check for annotation comments in any spec
  const annotationPattern = new RegExp(`covers:\\s*${method === '*' ? '\\w+' : method}\\s+${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '[^/]+')}`, 'i');
  if (annotationPattern.test(allSpecText)) continue;

  // Check for the path string appearing anywhere in any spec.
  // Strip :id placeholders to match the static prefix (e.g. '/admin/projects' covers '/admin/projects/:id').
  const staticPrefix = path.split('/:')[0];
  if (allSpecText.includes(staticPrefix)) continue;

  uncovered.push(key);
}

// ── Step 4: Report ────────────────────────────────────────────────────────────

const total    = unique.length;
const covered  = total - uncovered.length;

console.log(`\nRoute coverage: ${covered}/${total} routes referenced in e2e specs\n`);

if (uncovered.length) {
  console.error('Uncovered routes (add a spec reference or an ALLOWLIST entry):\n');
  for (const r of uncovered) {
    console.error(`  ✗  ${r}`);
  }
  console.error(`\n${uncovered.length} route(s) have no e2e spec reference.\n`);
  process.exit(1);
} else {
  console.log('All routes are covered. ✓\n');
}
