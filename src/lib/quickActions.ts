import { Activity, Camera, CreditCard, FileText, FolderOpen, LayoutDashboard, PackageCheck, ShoppingCart, type LucideIcon } from 'lucide-react';
import { isActiveRole, type ActiveRole, type Role } from './types';

export interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  roles: readonly ActiveRole[];
  kind: 'link' | 'capture';
  to?: string;
}

// The role-aware quick-action bar, phone only since the desktop speed-dial was removed
// (09.08.2026). Order is canonical and is asserted in layout.spec.ts.
const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new?fresh=1', roles: ['owner', 'office'] },
  { key: 'dashboard', label: 'מרכז הבקרה', icon: LayoutDashboard, kind: 'link', to: '/dashboard', roles: ['owner', 'office', 'accountant'] },
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office'] },
  { key: 'receive', label: 'קבלת סחורה', icon: PackageCheck, kind: 'link', to: '/receiving', roles: ['owner', 'office'] },
  // Keep five items for both procurement roles so capture stays in the exact middle. Document
  // operations is owner-only; office receives the permitted document gallery in the same slot.
  { key: 'document-operations', label: 'בקרת מסמכים', icon: Activity, kind: 'link', to: '/documents/operations', roles: ['owner'] },
  { key: 'documents', label: 'מסמכים', icon: FolderOpen, kind: 'link', to: '/documents', roles: ['office'] },
  // "חשבונית חדשה" was removed here (G1, 10.08.2026). This application RECEIVES supplier
  // invoices; it does not issue them to anyone. The action that replaces it already sits two rows
  // up: `capture` — photograph the invoice that arrived. `/invoices/new` still exists as a route,
  // reachable from a document that has been reviewed, which is the only way an invoice should
  // come into being.
  { key: 'invoices', label: 'חשבוניות', icon: FileText, kind: 'link', to: '/invoices', roles: ['accountant'] },
  { key: 'pay', label: 'תשלומים', icon: CreditCard, kind: 'link', to: '/pay', roles: ['accountant'] },
];

const FOCUS_PATHS = ['/orders/new', '/invoices/new', '/receiving/:orderId'] as const;

export function quickActionsFor(role: Role | null | undefined): QuickAction[] {
  return isActiveRole(role) ? QUICK_ACTIONS.filter((action) => action.roles.includes(role)) : [];
}

// desktopQuickActionsFor was removed with the desktop speed-dial (owner decision 09.08.2026).
// Quick actions are a phone surface now; on a desktop every page carries its own primary action.

export function isFocusPath(pathname: string): boolean {
  return FOCUS_PATHS.some((path) => path.includes(':')
    ? pathname.startsWith(`${path.slice(0, path.indexOf('/:'))}/`)
    : pathname === path);
}

/* ---------- Section identity — WHERE the user is, never WHAT the data says ---------- */

/**
 * The three work domains a daily user moves between. Not a tone, and structurally incapable of
 * becoming one: a section is derived from the URL by `sectionOf` and there is no prop, argument or
 * data field anywhere that can select it. `badge-await` is chosen by an invoice's status;
 * `documents` is chosen by standing on /documents. State cannot reach this vocabulary.
 *
 * The keys are deliberately domain nouns, never colour names and never a `Tone` value — the two
 * vocabularies share no member, which `quickActions.spec.ts` asserts.
 */
export type SectionKey = 'documents' | 'procurement' | 'money';

/**
 * Route prefixes per domain. These are the groups the navigation catalogue already uses
 * (מסמכים · רכש · כספים in `NAV_SECTIONS`), so the accent re-states an information architecture
 * the owner already approved rather than inventing a second one.
 *
 * Everything absent from this map answers `null` on purpose, and that is a design statement, not
 * an omission: `/dashboard` and the בקרה screens (`/alerts`, `/exceptions`, `/expenses`,
 * `/reports`, `/analytics`) look ACROSS all three domains, so they have no place of their own to
 * mark. `/settings`, `/onboarding` and `/admin` are not work domains either.
 */
const SECTION_ROUTES: Readonly<Record<SectionKey, readonly string[]>> = {
  documents: ['/documents'],
  procurement: ['/orders', '/receiving', '/inventory', '/suppliers', '/products', '/prices'],
  money: ['/invoices', '/credits', '/payment-requests', '/payments', '/bank', '/pay'],
};

/**
 * The work domain a path belongs to, or `null` where none does.
 *
 * Matching is exact-or-child on a `/` boundary, the same discipline `isRouteFamilyActive` uses:
 * `/payments` must not swallow `/payment-requests`, and `/pay` must not swallow either.
 */
export function sectionOf(pathname: string): SectionKey | null {
  const path = pathname.split(/[?#]/, 1)[0];
  for (const [key, prefixes] of Object.entries(SECTION_ROUTES) as [SectionKey, readonly string[]][]) {
    if (prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return key;
  }
  return null;
}

/** One route-family rule shared by the desktop sidebar and mobile drawer. */
export function isRouteFamilyActive(pathname: string, to: string): boolean {
  const targetPath = to.split(/[?#]/, 1)[0];
  if (targetPath === '/documents') {
    return pathname === targetPath || /^\/documents\/[^/]+\/review$/.test(pathname);
  }
  if (targetPath === '/documents/archive') return pathname === targetPath;
  if (['/orders', '/receiving', '/invoices', '/suppliers'].includes(targetPath)) {
    return pathname === targetPath || pathname.startsWith(`${targetPath}/`);
  }
  return pathname === targetPath;
}
