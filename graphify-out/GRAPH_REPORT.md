# Graph Report - .  (2026-05-31)

## Corpus Check
- 136 files · ~154,704 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 540 nodes · 1453 edges · 45 communities (31 shown, 14 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 34 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Worker Core Business Logic|Worker Core Business Logic]]
- [[_COMMUNITY_Admin Panel UI|Admin Panel UI]]
- [[_COMMUNITY_Gallery Management API|Gallery Management API]]
- [[_COMMUNITY_Project Documentation & Config|Project Documentation & Config]]
- [[_COMMUNITY_Authentication & Rate Limiting|Authentication & Rate Limiting]]
- [[_COMMUNITY_Test Request Helpers|Test Request Helpers]]
- [[_COMMUNITY_Worker Router Layer|Worker Router Layer]]
- [[_COMMUNITY_Worker Package Dependencies|Worker Package Dependencies]]
- [[_COMMUNITY_Test Package Dependencies|Test Package Dependencies]]
- [[_COMMUNITY_Workflow Automation Engine|Workflow Automation Engine]]
- [[_COMMUNITY_CI Route Coverage Check|CI Route Coverage Check]]
- [[_COMMUNITY_CORS & Security Constants|CORS & Security Constants]]
- [[_COMMUNITY_Invoice Tests|Invoice Tests]]
- [[_COMMUNITY_Gallery Config Encoding|Gallery Config Encoding]]
- [[_COMMUNITY_Admin JS Shared Utilities|Admin JS Shared Utilities]]
- [[_COMMUNITY_Public Site JS|Public Site JS]]
- [[_COMMUNITY_Contract Email Tests|Contract Email Tests]]
- [[_COMMUNITY_Walkthrough Admin Tests|Walkthrough Admin Tests]]
- [[_COMMUNITY_Services & Automation Tests|Services & Automation Tests]]
- [[_COMMUNITY_Portal Navigation Tests|Portal Navigation Tests]]
- [[_COMMUNITY_Rate Limiting Tests|Rate Limiting Tests]]
- [[_COMMUNITY_Gallery Assignment Tests|Gallery Assignment Tests]]
- [[_COMMUNITY_D1 Migration Tests|D1 Migration Tests]]
- [[_COMMUNITY_Questionnaire Tests|Questionnaire Tests]]
- [[_COMMUNITY_Pipeline Stage Tests|Pipeline Stage Tests]]
- [[_COMMUNITY_Production Deploy Script|Production Deploy Script]]
- [[_COMMUNITY_Scheduling Tests|Scheduling Tests]]
- [[_COMMUNITY_Auth E2E Tests|Auth E2E Tests]]
- [[_COMMUNITY_Availability Tests|Availability Tests]]
- [[_COMMUNITY_Portal Project Tests|Portal Project Tests]]
- [[_COMMUNITY_Preprod Deploy Script|Preprod Deploy Script]]
- [[_COMMUNITY_Registration Tests|Registration Tests]]
- [[_COMMUNITY_Proposal Tests|Proposal Tests]]
- [[_COMMUNITY_Site Config|Site Config]]
- [[_COMMUNITY_Contact E2E Tests|Contact E2E Tests]]
- [[_COMMUNITY_Pages Production Deploy|Pages Production Deploy]]
- [[_COMMUNITY_Pages Preprod Deploy|Pages Preprod Deploy]]
- [[_COMMUNITY_Worker Tests CI|Worker Tests CI]]
- [[_COMMUNITY_About Page|About Page]]

## God Nodes (most connected - your core abstractions)
1. `jsonResponse()` - 90 edges
2. `handleRequest()` - 83 edges
3. `getAuth()` - 59 edges
4. `authRequired()` - 57 edges
5. `createJWT()` - 52 edges
6. `forbidden()` - 50 edges
7. `fetch()` - 25 edges
8. `escHtml()` - 24 edges
9. `getUser()` - 22 edges
10. `putUser()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `apiFetch()` --calls--> `fetch()`  [INFERRED]
  site/admin/admin-shared.js → worker/cloudflare-worker.js
- `Invoice Page (invoice.html)` --calls--> `Cloudflare Worker API`  [EXTRACTED]
  site/invoice.html → worker/cloudflare-worker.js
- `Login Page (login.html)` --calls--> `Cloudflare Worker API`  [EXTRACTED]
  site/login.html → worker/cloudflare-worker.js
- `Project Portal (portal-project.html)` --calls--> `Cloudflare Worker API`  [EXTRACTED]
  site/portal-project.html → worker/cloudflare-worker.js
- `Client Portal My Account (portal.html)` --calls--> `Cloudflare Worker API`  [EXTRACTED]
  site/portal.html → worker/cloudflare-worker.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cloudflare Infrastructure Trio** — kv_namespace, d1_database, r2_bucket [EXTRACTED 0.95]
- **CI/CD Deployment Pipeline** — ci_pr_yml, deploy_prod_yml, deploy_worker_preprod_yml, migration_smoke_yml, run_migrations_prod_yml [EXTRACTED 0.95]
- **Full Booking Workflow Chain** — pipeline_kanban, contract_signing_workflow, stripe_billing [INFERRED 0.85]
- **Client Portal Shell (portal.html + portal-project.html + profile.html share nav and JWT auth)** — portal_clientportal, portalproject_projectportal, profile_profilepage [EXTRACTED 0.95]
- **Admin Panel Pages (pipeline + galleries + clients + services share admin nav, admin.css, admin-shared.js)** — admin_pipeline_pipelineadmin, admin_galleries_galleriesadmin, admin_clients_clientsadmin, admin_services_servicesadmin [EXTRACTED 1.00]
- **Transactional Document Flow (proposal → schedule → questionnaire → invoice form a sequential client booking funnel)** — proposal_proposalpage, schedule_schedulepage, questionnaire_questionnairepage, invoice_invoicepage [INFERRED 0.85]

## Communities (45 total, 14 thin omitted)

### Community 0 - "Worker Core Business Logic"
Cohesion: 0.08
Nodes (84): buildContractSnapshot(), handleAdminContractTemplateById(), handleAdminContractTemplates(), handleAdminProjectContractCountersign(), handleAdminProjectContracts(), handlePublicContractArchive(), handlePublicContractAudit(), handlePublicContractGet() (+76 more)

### Community 1 - "Admin Panel UI"
Cohesion: 0.15
Nodes (35): Admin Clients Page (admin/clients.html), Admin Galleries Page (admin/galleries.html), Admin Pipeline Page (admin/pipeline.html), Admin Services Page (admin/services.html), Admin Preview Mode (portal ?preview=1), Gallery Config Encoded in URL Hash (base64 JSON), Gaussian Splatting 3D Walkthroughs, Google OAuth Sign-In (GSI) (+27 more)

### Community 2 - "Gallery Management API"
Cohesion: 0.16
Nodes (26): handleAdminCreateGallery(), handleAdminDeleteGallery(), handleAdminUpdateGallery(), adminReq(), clientReq(), makeKv(), unauthEnv(), handleAdminCreateUser() (+18 more)

### Community 3 - "Project Documentation & Config"
Cohesion: 0.12
Nodes (30): Availability Calendar, CI PR Workflow, CLAUDE.md Project Instructions, Cloudflare Tunnel Config, Cloudflare Worker, Cloudflared Tunnel, Contract Signing Workflow, D1 Database (CTC_PROJECTS) (+22 more)

### Community 4 - "Authentication & Rate Limiting"
Cohesion: 0.16
Nodes (22): handleAuthLogin(), checkGalleryUnlockBruteForce(), checkLoginBruteForce(), checkResetBruteForce(), clearGalleryUnlockCounter(), clearLoginCounters(), getCount(), increment() (+14 more)

### Community 5 - "Test Request Helpers"
Cohesion: 0.09
Nodes (24): adminReq(), adminReq(), clientReq(), adminReq(), clientReq(), env(), makeDb(), adminReq() (+16 more)

### Community 6 - "Worker Router Layer"
Cohesion: 0.17
Nodes (19): get(), post(), post(), adminToken(), clientToken(), Database, __dir, makeD1() (+11 more)

### Community 7 - "Worker Package Dependencies"
Cohesion: 0.12
Nodes (15): dependencies, @cf-wasm/photon, devDependencies, better-sqlite3, vitest, @vitest/coverage-v8, wrangler, name (+7 more)

### Community 8 - "Test Package Dependencies"
Cohesion: 0.15
Nodes (12): devDependencies, http-server, @playwright/test, sharp, name, private, scripts, test (+4 more)

### Community 9 - "Workflow Automation Engine"
Cohesion: 0.32
Nodes (9): handleAdminAutomationLogs(), handleAdminAutomations(), handleScheduled(), logAutomation(), sendAutomationEmail(), clientReq(), env(), makeDb() (+1 more)

### Community 10 - "CI Route Coverage Check"
Cohesion: 0.17
Nodes (11): ALLOWLIST, allSpecText, __dir, lines, ROOT, routerSrc, routes, specDir (+3 more)

### Community 11 - "CORS & Security Constants"
Cohesion: 0.27
Nodes (9): ALLOWED_APIS, CORS, initCors(), adminReq(), baseEnv(), clientReq(), makeDb(), makeKv() (+1 more)

### Community 12 - "Invoice Tests"
Cohesion: 0.24
Nodes (8): CORS, daysAgo(), makeInvoice(), MOCK_LINE_ITEMS, MOCK_PROJECT, mockPortal(), mockWorker(), now()

### Community 13 - "Gallery Config Encoding"
Cohesion: 0.18
Nodes (3): CORS, MOCK_PHOTO, MOCK_VIDEO

### Community 14 - "Admin JS Shared Utilities"
Cohesion: 0.31
Nodes (5): apiFetch(), authGate(), getWorkerUrl(), highlightNav(), token()

### Community 15 - "Public Site JS"
Cohesion: 0.22
Nodes (8): fadeEls, form, getMenuCloseBtn(), nav, navLinks, observer, openMobileMenu(), toggle

### Community 16 - "Contract Email Tests"
Cohesion: 0.20
Nodes (5): ADMIN_PROJ, CLIENT_SIGNED_CONTRACT, CORS, FULLY_EXECUTED_CONTRACT, LONG_BODY

### Community 17 - "Walkthrough Admin Tests"
Cohesion: 0.29
Nodes (4): adminSetup(), CORS, MOCK_WALKTHROUGH, mockWorker()

### Community 18 - "Services & Automation Tests"
Cohesion: 0.29
Nodes (5): CORS, MOCK_AUTOMATIONS, MOCK_LOGS, mockWorker(), servicesAdminSetup()

### Community 19 - "Portal Navigation Tests"
Cohesion: 0.25
Nodes (5): ADMIN_NAV, CORS, PORTAL_TABS, PUBLIC_NAV, PUBLIC_PAGES

### Community 22 - "Gallery Assignment Tests"
Cohesion: 0.29
Nodes (3): CORS, MOCK_GALLERY, MOCK_USER

### Community 23 - "D1 Migration Tests"
Cohesion: 0.29
Nodes (5): Database, __dir, EXPECTED_TABLES, MIGRATIONS_DIR, require

### Community 26 - "Pipeline Stage Tests"
Cohesion: 0.33
Nodes (3): CORS, MOCK_PROJECTS, STAGES

### Community 27 - "Production Deploy Script"
Cohesion: 0.40
Nodes (3): deploy-worker.sh script, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN

### Community 32 - "Preprod Deploy Script"
Cohesion: 0.40
Nodes (3): deploy-worker-preprod.sh script, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN

## Knowledge Gaps
- **105 isolated node(s):** `name`, `version`, `private`, `type`, `test` (+100 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createJWT()` connect `Test Request Helpers` to `Worker Core Business Logic`, `Gallery Management API`, `Authentication & Rate Limiting`, `Worker Router Layer`, `Workflow Automation Engine`, `CORS & Security Constants`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `handleRequest()` connect `Worker Core Business Logic` to `Gallery Management API`, `Authentication & Rate Limiting`, `Worker Router Layer`, `Workflow Automation Engine`, `CORS & Security Constants`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `fetch()` connect `Worker Core Business Logic` to `Workflow Automation Engine`, `Gallery Management API`, `Authentication & Rate Limiting`, `Admin JS Shared Utilities`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _107 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Worker Core Business Logic` be split into smaller, more focused modules?**
  _Cohesion score 0.08260869565217391 - nodes in this community are weakly interconnected._
- **Should `Project Documentation & Config` be split into smaller, more focused modules?**
  _Cohesion score 0.11612903225806452 - nodes in this community are weakly interconnected._
- **Should `Test Request Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.09195402298850575 - nodes in this community are weakly interconnected._