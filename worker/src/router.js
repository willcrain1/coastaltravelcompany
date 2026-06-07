import { ALLOWED_ORIGIN, CORS, initCors } from './constants.js';
import { jsonResponse } from './utils.js';
import { getAuth } from './jwt.js';

import {
  handleAuthSetupStatus, handleAuthSetup, handleAuthRegister, handleAuthLogin,
  handleAuthGoogle, handleAuthResetRequest, handleAuthResetConfirm,
  handleAuthMe, handleAuthUpdateMe, handleAuthVerify, handleAuthResendVerify,
  handleAuthLogout,
} from './auth.js';

import { handleTokenExchange, handleNasProxy } from './gallery-proxy.js';
import { handleContact } from './contact.js';

import {
  handlePortalContracts, handlePortalGalleries, handleAdminProjectPortalLink,
  handlePublicProjectPortal, handleAdminProjectMessages, handlePortalMyProject,
} from './portal.js';

import {
  handleAdminListGalleries, handleAdminCreateGallery,
  handleAdminUpdateGallery, handleAdminDeleteGallery,
} from './admin/galleries.js';

import {
  handleAdminListUsers, handleAdminCreateUser,
  handleAdminUpdateUser, handleAdminDeleteUser,
  handleAdminUpdateUserRole,

} from './admin/users.js';

import {
  handleAdminPackages, handleAdminPackageById,
  handlePublicProposal, handlePublicProposalAnalytics, handlePublicProposalSelect,
  handleAdminProjectProposals,
} from './admin/packages.js';

import {
  handleAdminQuestionnaireSets, handleAdminQuestionnaireSetById,
  handleAdminProjectQuestionnaires, handlePublicQuestionnaire,
} from './admin/questionnaires.js';

import {
  handleAdminProjects, handleAdminProjectById,
  handleAdminProjectNotes, handleAdminProjectDocuments,
} from './admin/projects.js';

import {
  handlePublicAvailability,
  handleAdminAvailability, handleAdminBlockedDates,
  handleAdminProjectScheduleLinks, handlePublicSchedule,
} from './admin/scheduling.js';

import {
  handleAdminContractTemplates, handleAdminContractTemplateById,
  handleAdminProjectContracts, handleAdminProjectContractCountersign,
  handlePublicContractGet, handlePublicContractView,
  handlePublicContractSign, handlePublicContractAudit,
  handlePublicContractArchive,
} from './admin/contracts.js';

import {
  handleAdminProjectInvoices, handleAdminInvoice, handleAdminInvoiceSend,
  handlePublicInvoice, handleInvoiceCheckout, handleStripeWebhook, handlePortalInvoices,
} from './admin/invoices.js';

import { handleAdminAutomations, handleAdminAutomationLogs } from './admin/automations.js';
import { handleAdminMasqueradeStart, handleAdminMasqueradeExit } from './admin/masquerade.js';
import { handleAdminGallerySyncR2, handleAdminR2Storage } from './admin/r2-sync.js';

import {
  handlePublicWalkthroughs,
  handleAdminWalkthroughs,
  handleAdminWalkthroughById,
} from './walkthroughs.js';

import { handleAnalyticsEvent, handleAdminAnalyticsSummary } from './analytics.js';

import {
  handleAdminCmsPages,
  handleAdminCmsPage,
  handleAdminCmsHistory,
  handleAdminCmsRevert,
} from './admin/cms.js';

import {
  handleAdminStarsGet, handleAdminStarToggle, handleSubmitSelections,
} from './gallery-favorites.js';

export async function handleRequest(request, env) {
  initCors(env.ALLOWED_ORIGIN);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const origin  = request.headers.get('Origin');
  const referer = request.headers.get('Referer') || '';
  if (origin !== ALLOWED_ORIGIN && !referer.startsWith(ALLOWED_ORIGIN)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url      = new URL(request.url);
  const { pathname } = url;
  const method   = request.method;

  // ── Masquerade read-only enforcement ─────────────────────────────────────────
  // Masquerade tokens carry role='client' so admin routes are already gated.
  // This blocks mutating portal/auth actions a client could otherwise perform.
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && pathname !== '/admin/masquerade/exit') {
    const p = await getAuth(request, env);
    if (p?.masquerade) return jsonResponse({ error: 'Mutating actions are not permitted during a masquerade session' }, 403);
  }

  // ── Auth routes ──────────────────────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/auth/setup-status')   return handleAuthSetupStatus(env);
  if (method === 'POST' && pathname === '/auth/setup')          return handleAuthSetup(request, env);
  if (method === 'POST' && pathname === '/auth/register')       return handleAuthRegister(request, env);
  if (method === 'POST' && pathname === '/auth/login')          return handleAuthLogin(request, env);
  if (method === 'POST' && pathname === '/auth/google')         return handleAuthGoogle(request, env);
  if (method === 'POST' && pathname === '/auth/reset-request')  return handleAuthResetRequest(request, env);
  if (method === 'POST' && pathname === '/auth/reset-confirm')  return handleAuthResetConfirm(request, env);
  if (method === 'GET'   && pathname === '/auth/me')            return handleAuthMe(request, env);
  if (method === 'PATCH' && pathname === '/auth/me')            return handleAuthUpdateMe(request, env);
  if (method === 'POST'  && pathname === '/auth/logout')        return handleAuthLogout(env);
  if (method === 'GET'  && pathname === '/auth/verify')         return handleAuthVerify(request, env);
  if (method === 'POST' && pathname === '/auth/resend-verify')  return handleAuthResendVerify(request, env);

  // ── Public proposals ─────────────────────────────────────────────────────────
  const publicProposalMatch          = pathname.match(/^\/proposals\/([^/]+)$/);
  const publicProposalAnalyticsMatch = pathname.match(/^\/proposals\/([^/]+)\/analytics$/);
  const publicProposalSelectMatch    = pathname.match(/^\/proposals\/([^/]+)\/select$/);
  if (publicProposalMatch && method === 'GET')             return handlePublicProposal(request, env, publicProposalMatch[1]);
  if (publicProposalAnalyticsMatch && method === 'POST')   return handlePublicProposalAnalytics(request, env, publicProposalAnalyticsMatch[1]);
  if (publicProposalSelectMatch && method === 'POST')      return handlePublicProposalSelect(request, env, publicProposalSelectMatch[1]);

  // ── Admin: Masquerade ────────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/admin/masquerade')       return handleAdminMasqueradeStart(request, env);
  if (method === 'POST' && pathname === '/admin/masquerade/exit')  return handleAdminMasqueradeExit(request, env);

  // ── Admin: Gallery + User CRUD ───────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/admin/galleries') return handleAdminListGalleries(request, env);
  if (method === 'POST' && pathname === '/admin/galleries') return handleAdminCreateGallery(request, env);
  const galleryR2Match  = pathname.match(/^\/admin\/galleries\/([^/]+)\/sync-r2$/);
  if (galleryR2Match && method === 'POST') return handleAdminGallerySyncR2(request, env, galleryR2Match[1]);
  if (method === 'GET'  && pathname === '/admin/galleries/r2-storage') return handleAdminR2Storage(request, env);
  const galleryIdMatch = pathname.match(/^\/admin\/galleries\/([^/]+)$/);
  if (galleryIdMatch) {
    if (method === 'PUT')    return handleAdminUpdateGallery(request, env, galleryIdMatch[1]);
    if (method === 'DELETE') return handleAdminDeleteGallery(request, env, galleryIdMatch[1]);
  }
  if (method === 'GET'  && pathname === '/admin/users') return handleAdminListUsers(request, env);
  if (method === 'POST' && pathname === '/admin/users') return handleAdminCreateUser(request, env);
  const userIdMatch   = pathname.match(/^\/admin\/users\/([^/]+)$/);
  const userRoleMatch = pathname.match(/^\/admin\/users\/([^/]+)\/role$/);
  if (userRoleMatch && method === 'PATCH') return handleAdminUpdateUserRole(request, env, userRoleMatch[1]);
  if (userIdMatch) {
    if (method === 'PUT')    return handleAdminUpdateUser(request, env, userIdMatch[1]);
    if (method === 'DELETE') return handleAdminDeleteUser(request, env, userIdMatch[1]);
  }

  // ── Admin: Packages ──────────────────────────────────────────────────────────
  if (pathname === '/admin/packages') return handleAdminPackages(request, method, env);
  const packageIdMatch = pathname.match(/^\/admin\/packages\/([^/]+)$/);
  if (packageIdMatch) return handleAdminPackageById(request, method, env, packageIdMatch[1]);

  // ── Admin: Questionnaire sets ────────────────────────────────────────────────
  if (pathname === '/admin/questionnaires') return handleAdminQuestionnaireSets(request, method, env);
  const questionnaireIdMatch = pathname.match(/^\/admin\/questionnaires\/([^/]+)$/);
  if (questionnaireIdMatch) return handleAdminQuestionnaireSetById(request, method, env, questionnaireIdMatch[1]);

  // ── Admin: Project pipeline ──────────────────────────────────────────────────
  if (pathname === '/admin/projects') return handleAdminProjects(request, method, env);
  const projectIdMatch        = pathname.match(/^\/admin\/projects\/([^/]+)$/);
  const projectNotesMatch     = pathname.match(/^\/admin\/projects\/([^/]+)\/notes$/);
  const projectDocsMatch      = pathname.match(/^\/admin\/projects\/([^/]+)\/documents$/);
  const projectProposalsMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/proposals$/);
  if (projectIdMatch)        return handleAdminProjectById(request, method, env, projectIdMatch[1]);
  if (projectNotesMatch)     return handleAdminProjectNotes(request, method, env, projectNotesMatch[1]);
  if (projectDocsMatch)      return handleAdminProjectDocuments(request, method, env, projectDocsMatch[1]);
  if (projectProposalsMatch) return handleAdminProjectProposals(request, method, env, projectProposalsMatch[1]);

  // ── Portal ───────────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/portal/galleries')  return handlePortalGalleries(request, env);
  if (method === 'GET' && pathname === '/portal/invoices')   return handlePortalInvoices(request, env);
  if (method === 'GET' && pathname === '/portal/contracts')  return handlePortalContracts(request, env);
  if (pathname === '/portal/my-project' && (method === 'GET' || method === 'POST'))
    return handlePortalMyProject(request, method, env);

  // ── Questionnaire instances ──────────────────────────────────────────────────
  const projectQuestionnairesMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/questionnaires$/);
  if (projectQuestionnairesMatch)
    return handleAdminProjectQuestionnaires(request, method, env, projectQuestionnairesMatch[1]);
  const publicQnMatch = pathname.match(/^\/questionnaire\/([^/]+)$/);
  if (publicQnMatch && (method === 'GET' || method === 'POST'))
    return handlePublicQuestionnaire(request, method, env, publicQnMatch[1]);

  // ── Project portal & messaging ───────────────────────────────────────────────
  const projectPortalLinkMatch  = pathname.match(/^\/admin\/projects\/([^/]+)\/portal-link$/);
  const projectMsgMatch         = pathname.match(/^\/admin\/projects\/([^/]+)\/messages$/);
  const publicPortalProjMatch   = pathname.match(/^\/portal\/project\/([^/]+)$/);
  if (projectPortalLinkMatch && method === 'POST')
    return handleAdminProjectPortalLink(request, env, projectPortalLinkMatch[1]);
  if (projectMsgMatch)
    return handleAdminProjectMessages(request, method, env, projectMsgMatch[1]);
  if (publicPortalProjMatch && (method === 'GET' || method === 'POST'))
    return handlePublicProjectPortal(request, method, env, publicPortalProjMatch[1]);

  // ── Scheduling ───────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/public/availability') return handlePublicAvailability(env);
  if (pathname === '/admin/availability' && (method === 'GET' || method === 'PUT'))
    return handleAdminAvailability(request, method, env);
  const blockedDateDelMatch = pathname.match(/^\/admin\/blocked-dates\/([^/]+)$/);
  if (pathname === '/admin/blocked-dates' || blockedDateDelMatch)
    return handleAdminBlockedDates(request, method, env, blockedDateDelMatch?.[1]);
  const projectSchedMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/schedule-links$/);
  if (projectSchedMatch)
    return handleAdminProjectScheduleLinks(request, method, env, projectSchedMatch[1]);
  const publicSchedMatch = pathname.match(/^\/schedule\/([^/]+)$/);
  if (publicSchedMatch && (method === 'GET' || method === 'POST'))
    return handlePublicSchedule(request, method, env, publicSchedMatch[1]);

  // ── Automations ──────────────────────────────────────────────────────────────
  if (pathname === '/admin/automations' && (method === 'GET' || method === 'PUT'))
    return handleAdminAutomations(request, method, env);
  if (method === 'GET' && pathname === '/admin/automation-logs')
    return handleAdminAutomationLogs(request, env);

  // ── Contract templates ───────────────────────────────────────────────────────
  if (pathname === '/admin/contract-templates') return handleAdminContractTemplates(request, method, env);
  const contractTemplateIdMatch = pathname.match(/^\/admin\/contract-templates\/([^/]+)$/);
  if (contractTemplateIdMatch) return handleAdminContractTemplateById(request, method, env, contractTemplateIdMatch[1]);

  // ── Project contracts ────────────────────────────────────────────────────────
  const projectContractsMatch           = pathname.match(/^\/admin\/projects\/([^/]+)\/contracts$/);
  const projectContractCountersignMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/contracts\/([^/]+)\/countersign$/);
  if (projectContractsMatch) {
    const p = await getAuth(request, env);
    if (!p) return jsonResponse({ error: 'Authentication required' }, 401);
    if (p.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
    return handleAdminProjectContracts(request, method, env, projectContractsMatch[1], p);
  }
  if (projectContractCountersignMatch && method === 'POST') {
    const p = await getAuth(request, env);
    if (!p) return jsonResponse({ error: 'Authentication required' }, 401);
    if (p.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
    return handleAdminProjectContractCountersign(request, env, projectContractCountersignMatch[1], projectContractCountersignMatch[2], p);
  }

  // ── Public contract signing ──────────────────────────────────────────────────
  const publicContractMatch         = pathname.match(/^\/contracts\/([^/]+)$/);
  const publicContractViewMatch     = pathname.match(/^\/contracts\/([^/]+)\/view$/);
  const publicContractSignMatch     = pathname.match(/^\/contracts\/([^/]+)\/sign$/);
  const publicContractAuditMatch    = pathname.match(/^\/contracts\/([^/]+)\/audit$/);
  const publicContractArchiveMatch  = pathname.match(/^\/contracts\/([^/]+)\/archive$/);
  if (publicContractMatch && method === 'GET')         return handlePublicContractGet(request, env, publicContractMatch[1]);
  if (publicContractViewMatch && method === 'POST')    return handlePublicContractView(request, env, publicContractViewMatch[1]);
  if (publicContractSignMatch && method === 'POST')    return handlePublicContractSign(request, env, publicContractSignMatch[1]);
  if (publicContractAuditMatch && method === 'GET')    return handlePublicContractAudit(request, env, publicContractAuditMatch[1]);
  if (publicContractArchiveMatch && method === 'GET')  return handlePublicContractArchive(request, env, publicContractArchiveMatch[1]);

  // ── Invoices ─────────────────────────────────────────────────────────────────
  const projectInvoicesMatch       = pathname.match(/^\/admin\/projects\/([^/]+)\/invoices$/);
  const adminInvoiceSendMatch      = pathname.match(/^\/admin\/invoices\/([^/]+)\/send$/);
  const adminInvoiceMatch          = pathname.match(/^\/admin\/invoices\/([^/]+)$/);
  const publicInvoiceCheckoutMatch = pathname.match(/^\/invoices\/([^/]+)\/checkout$/);
  const publicInvoiceMatch         = pathname.match(/^\/invoices\/([^/]+)$/);
  if (projectInvoicesMatch)
    return handleAdminProjectInvoices(request, method, env, projectInvoicesMatch[1]);
  if (adminInvoiceSendMatch && method === 'POST')
    return handleAdminInvoiceSend(request, env, adminInvoiceSendMatch[1]);
  if (adminInvoiceMatch && (method === 'GET' || method === 'PUT'))
    return handleAdminInvoice(request, method, env, adminInvoiceMatch[1]);
  if (publicInvoiceCheckoutMatch && method === 'POST')
    return handleInvoiceCheckout(request, env, publicInvoiceCheckoutMatch[1]);
  if (publicInvoiceMatch && method === 'GET')
    return handlePublicInvoice(request, env, publicInvoiceMatch[1]);
  if (method === 'POST' && pathname === '/stripe/webhook')
    return handleStripeWebhook(request, env);

  // ── Gallery favorites & admin stars ─────────────────────────────────────────
  const adminStarsGalleryMatch = pathname.match(/^\/gallery\/([^/]+)\/admin-stars$/);
  const adminStarsPhotoMatch   = pathname.match(/^\/gallery\/([^/]+)\/admin-stars\/([^/]+)$/);
  const submitSelectionsMatch  = pathname.match(/^\/gallery\/([^/]+)\/submit-selections$/);
  if (adminStarsGalleryMatch && method === 'GET')  return handleAdminStarsGet(request, env, adminStarsGalleryMatch[1]);
  if (adminStarsPhotoMatch   && method === 'PUT')  return handleAdminStarToggle(request, env, adminStarsPhotoMatch[1], adminStarsPhotoMatch[2]);
  if (submitSelectionsMatch  && method === 'POST') return handleSubmitSelections(request, env, submitSelectionsMatch[1]);

  // ── CMS ───────────────────────────────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/admin/cms/pages')   return handleAdminCmsPages(request, env);
  if (pathname === '/admin/cms/page' && (method === 'GET' || method === 'PUT'))
    return handleAdminCmsPage(request, env);
  if (method === 'GET'  && pathname === '/admin/cms/history') return handleAdminCmsHistory(request, env);
  if (method === 'POST' && pathname === '/admin/cms/revert')  return handleAdminCmsRevert(request, env);

  // ── Walkthroughs ─────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/public/walkthroughs') return handlePublicWalkthroughs(request, env);
  if (pathname === '/admin/walkthroughs') return handleAdminWalkthroughs(request, env);
  const walkthroughIdMatch = pathname.match(/^\/admin\/walkthroughs\/([^/]+)$/);
  if (walkthroughIdMatch) return handleAdminWalkthroughById(request, env, walkthroughIdMatch[1]);

  // ── Analytics (items 32 & 46) ────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/analytics/event')          return handleAnalyticsEvent(request, env);
  if (method === 'GET'  && pathname === '/admin/analytics/summary')  return handleAdminAnalyticsSummary(request, env);

  // ── Token exchange + contact form ────────────────────────────────────────────
  if (method === 'POST' && pathname === '/token')   return handleTokenExchange(request, env);
  if (method === 'POST' && pathname === '/contact') return handleContact(request, env);

  // ── NAS proxy (fallthrough) ──────────────────────────────────────────────────
  return handleNasProxy(request, env);
}
