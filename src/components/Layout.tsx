import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { Link, Outlet, useNavigate, useLocation, useSearchParams } from 'react-router';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, FileCheck2, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, Activity, PieChart, Settings, LogOut, X, Bell, Search, FolderOpen, Archive, ChevronDown, ListChecks, Warehouse, ArrowRight, ScrollText, CircleHelp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useInboxCount } from '../lib/useInboxCount';
import { APP_NAME } from '../lib/branding';
import { useGlowPointer } from '../lib/glowPointer';
import GlobalSearch, { canGlobalSearch } from './GlobalSearch';
import Fab from './Fab';
import AssistantPanel from './AssistantPanel';
import { assistantAuthorizationFingerprint, useAssistantRunSession } from '../lib/assistant/runSession';
import NotificationBell from './NotificationBell';
import FeedbackButton from './FeedbackButton';
import { PlanBadge } from './PlanBadge';
import { ConfirmDialog, ICON, useDialogLayer, useToast } from './ui';
import { ORDER_DRAFT_FLUSH_EVENT, type OrderDraftFlushDetail } from '../lib/orderDrafts';
import { pendingOfflineWork } from '../lib/offlineQueue';
import { isActiveRole, type ActiveRole } from '../lib/types';
import { supabase } from '../lib/supabase';
import { ACTIVE_ORGANIZATION_ACCESS } from '../lib/organizationAccess';
import { isRouteFamilyActive, sectionOf } from '../lib/quickActions';
import { useWithheldNavPaths } from '../lib/entitlements';
import { routeBackPresentation, routePresentationTitle, staticRouteTitle, type StaticRoutePath } from '../lib/routePresentation';
import { tourNavigationAnchor, type ProductTourStep } from '../lib/productTourRegistry';
import { OwnerProductTour, type OwnerProductTourHandle } from './product-tour/ProductTour';
import { EntityMonogram } from './EntityMonogram';

/** Paper panel, floating pill, or the onyx drawer. See `linkCls`. */
type NavSurface = 'pill' | 'panel' | 'shell';

export interface NavItem { to: string; labelKey: TKey; icon: typeof LayoutDashboard; roles: ActiveRole[] }
export interface NavSection { section: TKey | ''; items: NavItem[]; collapsible?: boolean }

/* "The menu is open" is a place, not a component state (owner, 19.08.2026: the iPhone back gesture
   left the application instead of returning to the menu the screen was chosen from). Opening the
   drawer PUSHES `?menu=1` onto the router's history; picking a destination navigates to a URL
   without it, so the drawer derives itself shut and the marker entry stays behind for `back` to
   land on. Escape / backdrop / X consume that entry with `navigate(-1)` instead, so closing never
   walks the user out of the application.
   The marker rides the search string rather than the hash because `setSearchParams` resolves an
   empty hash away, and several screens write params from effects while mounted.
   CAUTION for future param writers: this only survives because every writer in the codebase builds
   its next value from `new URLSearchParams(current)`. A writer that passes a fresh object literal
   drops the marker and silently closes the drawer under the user. */
const MENU_PARAM = 'menu';

function navItem(to: StaticRoutePath, icon: typeof LayoutDashboard, roles: ActiveRole[]): NavItem {
  return { to, labelKey: staticRouteTitle(to), icon, roles };
}

/* NAV_SHORT_LABELS stood here until 28.08.2026. It existed because the desktop pill was one slim
   row of TEXT items and the full Hebrew titles did not fit it — /orders showed "הזמנות",
   /documents showed "מסמכים". After the reorganisation the pill's only plain links are
   /dashboard and /orders/new; every other destination lives in a group panel, which always
   rendered the full name. A map of short forms for links that no longer exist is a second set of
   labels waiting to drift from the catalogue, so it went with them. */

// Four work groups — מסמכים / רכש / כספים / בקרה — under two ungrouped links that need no
// header to explain them. The less self-evident items (מחירונים, דרישות תשלום, התאמות בנק,
// הגדרות, and the focused /pay route) sit where the plain
// procurement/finance/control reading puts them.
// None of it invents business meaning.
//
// יומן ביקורת was here until 10.08.2026 — a page-sized table of raw mutation rows for the whole
// system, which answered no question a business owner actually asks. That screen is NOT coming
// back. What came back on 19.08.2026, by owner decision, is the one question it did answer and
// nothing else: יומן עדכון ספקים (/supplier-log) — `suppliers` and `supplier_products` only, with
// the price read as before→after instead of raw JSON, because "מי שינה את המחיר של המוצר" had no
// surface at all. Owner only: the ledger is owner+accountant while the names in it are
// owner+office, so an accountant would read UUIDs. The LEDGER itself never moved — audit_logs, its
// server-side triggers, the reason on every sensitive command and the immutability rules are what
// make this a financial system and they are untouched.
export const NAV_SECTIONS: NavSection[] = [
  {
    // מרכז הבקרה ראשון: הוא התשובה לסעיף 12 — מה דורש טיפול, עכשיו. הזמנה חדשה אחריו,
    // כי היא הפעולה התכופה ביותר אבל לא זו שפותחים איתה את היום.
    section: '',
    items: [
      navItem('/dashboard', LayoutDashboard, ['owner', 'office', 'accountant']),
      navItem('/orders/new', ShoppingCart, ['owner', 'office']),
    ],
  },
  {
    // Documents stand apart from כספים because a scanned page is not yet a financial fact: it is
    // read and filed first, and only then becomes an invoice or a credit. The queue that does the
    // reading belongs beside the ledgers it feeds, not inside them.
    section: 'nav.text_5',
    items: [
      navItem('/documents/operations', Activity, ['owner']),
      navItem('/documents/consolidated-invoices', FileCheck2, ['owner', 'office', 'accountant']),
      navItem('/documents', FolderOpen, ['owner', 'office']),
      navItem('/documents/archive', Archive, ['owner', 'office']),
    ],
  },
  {
    section: 'nav.text_6',
    items: [
      navItem('/orders', ClipboardList, ['owner', 'office']),
      navItem('/receiving', PackageCheck, ['owner', 'office']),
      navItem('/inventory', Warehouse, ['owner', 'office']),
      navItem('/suppliers', Truck, ['owner', 'office']),
      navItem('/products', Package, ['owner', 'office']),
      navItem('/prices', Tags, ['owner', 'office']),
    ],
  },
  {
    section: 'nav.text_7',
    items: [
      navItem('/invoices', FileText, ['owner', 'office', 'accountant']),
      navItem('/credits', RotateCcw, ['owner', 'office', 'accountant']),
      navItem('/payment-requests', Send, ['owner', 'office']),
      navItem('/payments', CreditCard, ['owner', 'accountant']),
      navItem('/bank', Landmark, ['owner', 'accountant']),
      navItem('/pay', CreditCard, ['accountant']),
    ],
  },
  {
    section: 'nav.text_8',
    items: [
      navItem('/alerts', Bell, ['owner', 'office']),
      navItem('/exceptions', AlertTriangle, ['owner', 'office', 'accountant']),
      navItem('/expenses', PieChart, ['owner', 'accountant']),
      navItem('/reports', BarChart3, ['owner', 'accountant']),
      navItem('/analytics', Activity, ['owner', 'office']),
      navItem('/supplier-log', ScrollText, ['owner']),
      navItem('/settings', Settings, ['owner']),
      // The subscription left the settings screen for an address of its own (owner report
      // 25.08.2026). It is catalogued here beside /settings because this array is the permission
      // record for every authenticated destination; where it SURFACES is decided below, by
      // SUBSCRIPTION_PATHS, and that is its own drawer group rather than a row inside control.
      navItem('/settings/subscription', CreditCard, ['owner']),
      // /onboarding was absent from this catalogue entirely, so nothing could route to it: not the
      // sidebar, not the drawer, not quickActions, and homeFor() always answers /dashboard. The
      // setup wizard was built to be RE-OPENED — it reads live counts on every mount so it shows
      // true completion state rather than a remembered claim (Onboarding.tsx:32-45) — and the one
      // thing missing was a door. It belongs to the owner, beside /settings, not in daily work.
      // The shared presentation catalogue keeps this label identical in the drawer and title bar.
      navItem('/onboarding', ListChecks, ['owner']),
    ],
  },
];

/**
 * ONE grouping, by subject, for every role and both surfaces (owner approval 28.08.2026).
 *
 * What it replaces, and why the replacement is the fix rather than a rearrangement: this file
 * carried TWO groupings of the same screens. `NAV_SECTIONS` grouped them by subject —
 * מסמכים / רכש / כספים / בקרה — and four per-role path maps regrouped them by FREQUENCY —
 * daily / ניהול / בקרה — and the second is what the drawer actually rendered. So "ניהול" held the
 * product catalogue and the bank together, "בקרה" held document operations next to the reports,
 * and a person looking for מחירונים had to know which of the two mental models the menu was
 * using. The owner's words: "יש בלאגן, לא מבינים את הניווט כמו שצריך".
 *
 * There is now one list. `NAV_SECTIONS` below stays what it always was — the permission-aware
 * catalogue, the record of which role may reach which destination — and this decides the ORDER and
 * the grouping a person sees. A role simply never sees the paths its catalogue entry withholds, so
 * one list serves owner, office and accountant without three copies to drift apart: an accountant's
 * 'רכש' group resolves to nothing and is dropped.
 */
const NAV_GROUPS: readonly { section: TKey | ''; paths: readonly string[] }[] = [
  // The control room first — it is the answer to §12, "what needs attention now" — and the single
  // most frequent action after it. Nothing else earns a place above a group heading.
  { section: '', paths: ['/dashboard', '/orders/new'] },
  { section: 'nav.groupPurchasing', paths: ['/orders', '/receiving', '/suppliers', '/products', '/prices', '/inventory'] },
  // Documents stand apart from כספים because a scanned page is not yet a financial fact: it is
  // read and filed first, and only then becomes an invoice or a credit.
  { section: 'nav.groupDocuments', paths: ['/documents', '/documents/consolidated-invoices', '/documents/archive', '/documents/operations'] },
  { section: 'nav.groupFinance', paths: ['/invoices', '/credits', '/payment-requests', '/payments', '/pay', '/bank'] },
  { section: 'nav.groupControlReports', paths: ['/alerts', '/exceptions', '/expenses', '/reports', '/analytics', '/supplier-log'] },
  // Last, and the separation DESIGN.md:509 asks for: the contract the business runs under, and the
  // screens that configure it, are not one more work destination. It is owner-only by catalogue,
  // so the group simply does not resolve for anybody else.
  { section: 'nav.groupAccount', paths: ['/settings/subscription', '/onboarding', '/settings'] },
];

/** The account group lives in the avatar menu on desktop; showing it twice on one screen is noise. */
const DESKTOP_HIDDEN_SECTION: TKey = 'nav.groupAccount';

function catalogItem(path: string, role: ActiveRole): NavItem | null {
  const item = NAV_SECTIONS.flatMap((section) => section.items).find((candidate) => candidate.to === path);
  return item?.roles.includes(role) ? item : null;
}

function itemsFor(role: ActiveRole, paths: readonly string[]): NavItem[] {
  return paths.map((path) => catalogItem(path, role)).filter((item): item is NavItem => item !== null);
}

// NAV_SECTIONS remains the complete permission-aware route catalogue. This function is the calmer
// presentation: daily work is visible; management and control are progressively disclosed. New
// order, alerts and archive keep their routes and page titles but enter through their contextual
// surfaces instead of competing with modules in the sidebar.
export function sectionsForRole(role: ActiveRole | undefined): NavSection[] {
  // The 'פלטפורמה' section that used to be appended here for a platform admin is gone with the
  // operator console itself (19.08.2026): /admin now lives in the separate operator application
  // (operator.html, src/operator/), and the tenant shell offers no door to it. This catalogue is
  // tenant navigation only.
  return role
    ? NAV_GROUPS
      .map((group) => ({ section: group.section, items: itemsFor(role, group.paths) }))
      .filter((section) => section.items.length > 0)
    : [];
}

/** The desktop pill's groups. The account group is reached through the avatar disc instead. */
export function barSectionsForRole(role: ActiveRole | undefined): NavSection[] {
  return sectionsForRole(role).filter((section) => section.section !== DESKTOP_HIDDEN_SECTION);
}

/** What the desktop avatar menu holds — the same account group, in the surface that owns it. */
export function footerItemsForRole(role: ActiveRole | undefined): NavItem[] {
  return role === 'owner' ? itemsFor(role, ['/settings/subscription', '/onboarding', '/settings']) : [];
}

const NOTHING_WITHHELD: ReadonlySet<string> = new Set();
const SETUP_FINISHED_WITHHELD: ReadonlySet<string> = new Set(['/onboarding']);

/**
 * What a FINISHED setup withholds (0258).
 *
 * The wizard is the one entry in the account group that is an ERRAND rather than a place, and it
 * was catalogued like a place: permanently, for every owner, in the sidebar and the avatar menu,
 * with nothing that could ever retire it. An owner who had opened an account, signed in and filled
 * the system was still being offered "set the system up" every session — their report, 30.08.2026.
 *
 * The signal is the owner's own explicit finish, not a row count: `organizations.
 * onboarding_completed_at`. A count would answer a different question (see the column comment).
 *
 * Withheld here rather than removed from `sectionsForRole` for the reason `surfaced` states
 * below: that function is the role catalogue, `layout.spec.ts` reads it as one, and this is not a
 * question about roles. Withholding only ever REMOVES, so a group emptied by it disappears.
 *
 * The route stays live and `/settings` keeps its link on purpose — the same screen is the bulk
 * import path, and a business buying a new price list months later needs it again.
 */
export function withheldNavPathsAfterSetup(
  onboardingCompletedAt: string | null | undefined,
): ReadonlySet<string> {
  return onboardingCompletedAt ? SETUP_FINISHED_WITHHELD : NOTHING_WITHHELD;
}

/**
 * The drawer's own list.
 *
 * It used to rename the leading unnamed group to 'עבודה שוטפת', because the drawer printed a
 * heading over every group and an unnamed one would have been a heading-shaped hole. The drawer
 * prints no headings any more (owner, 28.08.2026: "אין צורך בפסי הפרדה לשים עוד טקסט - הפסי
 * הפרדה מספיקים"), so the rename would put a word on a surface that renders none.
 *
 * The function stays rather than folding into `sectionsForRole` at the call site: it is the one
 * place that says which list the drawer shows, and the two surfaces have already diverged once
 * (the bar withholds the account group). A second divergence should have somewhere to land.
 */
export function drawerSectionsForRole(role: ActiveRole | undefined): NavSection[] {
  return sectionsForRole(role);
}

/* `showNavHeaders` lived here until 26.08.2026: an exported predicate about whether group headers
   earn their space, asserted by a spec and consulted by no renderer at all. The rule it stood for
   is not gone — it is enforced where it is visible instead: a NAMED group holding exactly one
   destination renders as a plain link rather than a disclosure (DESIGN.md:507, "דיסקלוזר מעל פריט
   אחד הוא דלת עם מכסה"), which `topNavGroup`'s caller below decides and the drawer inherits. */

/**
 * The browser title, as a KEY or the product name.
 *
 * Returns `null` for a route the catalogue does not name, so the caller decides — `APP_NAME` is
 * the product's own name and is not translated, which makes it the one value here that must not
 * go through `t`.
 */
export function pageTitleKeyFor(pathname: string): TKey | null {
  return routePresentationTitle(pathname);
}

export default function Layout() {
  const { errorText, t } = useT();
  useGlowPointer();
  const { session, profile, org, roleLabels, organizationAccess = ACTIVE_ORGANIZATION_ACCESS, accessStatus = 'unknown', signOut } = useAuth();
  const assistantSession = useAssistantRunSession(assistantAuthorizationFingerprint({
    userId: session?.user.id,
    profileId: profile?.id,
    orgId: org?.id ?? profile?.org_id,
    role: profile?.role,
    profileActive: profile?.active,
    orgStatus: org?.status,
    accessMode: organizationAccess.mode,
    accessStatus,
  }));
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Derived, never stored: the URL is the single source of truth for the drawer, which is what
  // makes reload, a pasted `?menu=1` link and the back gesture all agree without extra handling.
  const mobileOpen = searchParams.has(MENU_PARAM);
  // Whether THIS session pushed the marker entry (as opposed to arriving on one), which decides
  // whether closing consumes a history entry or rewrites the current one.
  const pushedMenuRef = useRef(false);
  const mobileOpenRef = useRef(mobileOpen);
  mobileOpenRef.current = mobileOpen;
  const [searchOpen, setSearchOpen] = useState(false);
  /* T7.1 top navigation: which desktop dropdown group is open (one at a time; null = none).
     Disclosure-nav pattern — aria-expanded button + a list of real links, no menu roles. */
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const topNavRef = useRef<HTMLElement>(null);
  const phoneHeaderRef = useRef<HTMLElement>(null);
  const ownerTourRef = useRef<OwnerProductTourHandle>(null);
  /* Is the page ALREADY saying which screen this is? See `useEffect` below. `false` is the safe
     value in every direction — unknown, unobservable, no heading at all — because it means the bar
     names the screen, and a bar that stays blank is the failure nobody sees. */
  const [pageHeadingVisible, setPageHeadingVisible] = useState(false);
  const [pendingOffline, setPendingOffline] = useState<{ actions: number; uploads: number } | null>(null);
  const role = isActiveRole(profile?.role) ? profile.role : undefined;
  const canSearch = canGlobalSearch(role);
  // Feedback is a product surface for every active account, not a rollout flag that can make the
  // user's screenshot option disappear between sessions. `FeedbackButton` renders nothing without a
  // profile, so the shell no longer keeps a second always-true copy of that condition.
  // Unfiled-documents pill (0014): counted only for staff who can act on that queue. The
  // Only procurement staff can act on the gallery queue. A known count > 0 is required,
  // so null (loading) and 0 never fabricate an all-clear or workload.
  const inboxCount = useInboxCount(role === 'owner' || role === 'office');
  const orgName = org?.name ?? '';
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;
  const currentTitleKey = pageTitleKeyFor(location.pathname);
  const currentTitle = currentTitleKey ? t(currentTitleKey) : APP_NAME;
  const routeBack = routeBackPresentation(location.pathname);

  /**
   * The mark at the start of every shell surface — ONE writing of it, at three sizes.
   *
   * OUR mark is `/favicon.svg`: the bare symbol on a transparent ground (owner, 26.08.2026 —
   * "הלוגו צריך להיות ללא הריבוע הכהה הוא צריך להיות כמו ה FAVICON"). Until now all three sites
   * pointed at `/icons/icon-192.png`, which is the HOME-SCREEN icon: the same symbol pressed onto
   * a dark rounded square. Dropped into the header it became a dark tile inside a white plate
   * inside a pill — three nested shapes for one mark, and the darkest object on the phone bar.
   *
   * A TENANT logo keeps the plate, and that is not an inconsistency. A business uploads a PNG
   * that may be transparent, may be light-on-dark, and is not ours to redraw; `bg-white` +
   * `ring-line-soft` is the neutral card it needs to sit on any surface (DESIGN.md records that
   * literal as deliberate for exactly this case). Our own symbol is a known shape in a known ink
   * and needs no card — so it does not get one.
   *
   * `rounded-lg`, never a circle: `object-contain` inside `rounded-full` crops the ends off a wide
   * wordmark, which is the shape most business logos have.
   */
  /* THE LADDER, in one place, after the owner shrank it and then removed a rung on 26.08.2026:
       drawer  32px (`size-8`)  — was 40. A whole row to itself, above the product and tenant
                                  names, so it stays the larger of the two.
       bar     28px (`size-7`)  — was 32. The DESKTOP pill only: the owner crossed the mark off
                                  the phone and tablet bar, so 'bar' now has exactly one caller.
     The 40px drawer mark was sized when the mark was a dark tile that needed the area to read;
     bare on paper at 32 it reads at a glance and stops dominating the two lines of text beside
     it. The name 'bar' is kept rather than renamed to 'desktop' because the size is the pill's,
     not the breakpoint's — if the mark ever returns to a phone surface it returns at 28. */
  const brandMark = (size: 'bar' | 'drawer') => {
    const px = size === 'drawer' ? 32 : 28;
    const box = size === 'drawer' ? 'size-8' : 'size-7';
    return orgLogoUrl
      ? <img src={orgLogoUrl} alt="" width={px} height={px}
        className={`${box} shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-line-soft`} />
      : <img src="/favicon.svg" alt="" width={px} height={px}
        className={`${box} shrink-0 object-contain`} />;
  };

  /**
   * What the PLAN and a FINISHED SETUP withhold, applied on top of what the ROLE allows.
   *
   * Three different questions about the same list, kept as separate steps: `sectionsForRole` is the
   * role catalogue and `layout.spec.ts` asserts it as one, so folding either of the others into it
   * would make all three unreadable. Both withholders only ever REMOVE rows, so the catalogue stays
   * the outer bound, and a group emptied by them disappears rather than standing as a heading over
   * nothing.
   */
  const planWithheld = useWithheldNavPaths();
  const setupWithheld = withheldNavPathsAfterSetup(org?.onboarding_completed_at);
  const withheld = setupWithheld.size === 0
    ? planWithheld
    : new Set([...planWithheld, ...setupWithheld]);
  const surfaced = (list: NavSection[]) => (withheld.size === 0 ? list : list
    .map((section) => ({ ...section, items: section.items.filter((item) => !withheld.has(item.to)) }))
    .filter((section) => section.items.length > 0));

  const sections = surfaced(barSectionsForRole(role));
  const drawerSections = surfaced(drawerSectionsForRole(role));
  const footerItems = footerItemsForRole(role).filter((item) => !withheld.has(item.to));

  // The current screen with a rewritten query — the pathname and hash are carried through so the
  // marker never doubles as a navigation.
  const hereWith = (params: URLSearchParams) => {
    const search = params.toString();
    return { pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash };
  };

  function openMobileMenu() {
    const next = new URLSearchParams(searchParams);
    next.set(MENU_PARAM, '1');
    pushedMenuRef.current = true;
    navigate(hereWith(next)); // a PUSH — this entry is what the back gesture returns to
  }

  const prepareOwnerTourStep = useCallback((step: ProductTourStep) => {
    if (!step.prepare) return;
    const desktop = window.matchMedia('(min-width: 64rem)').matches;
    if (desktop) {
      setOpenGroup(
        step.prepare === 'management' ? 'nav.text_6'
          : step.prepare === 'control' ? 'nav.text_8'
            : step.prepare === 'account' ? 'account'
              : null,
      );
      return;
    }
    if (mobileOpenRef.current) return;
    const next = new URLSearchParams(searchParams);
    next.set(MENU_PARAM, '1');
    pushedMenuRef.current = true;
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash });
  }, [location.hash, location.pathname, navigate, searchParams]);

  const { panelRef: drawerRef, requestClose: closeMobileMenu } = useDialogLayer<HTMLElement>({
    open: mobileOpen,
    // Every deliberate close — Escape, the backdrop, the X, a resize into desktop — arrives here.
    onClose: () => {
      const next = new URLSearchParams(searchParams);
      next.delete(MENU_PARAM);
      if (pushedMenuRef.current) {
        pushedMenuRef.current = false;
        navigate(-1); // consume the entry we pushed rather than stack a second one on top of it
      } else {
        // Reload, or a link someone pasted with the marker already in it: there is no entry of
        // ours to consume, and stepping back would leave the application.
        navigate(hereWith(next), { replace: true });
      }
    },
    initialFocus: (panel) => panel.querySelector<HTMLElement>('[aria-current="page"]')
      ?? panel.querySelector<HTMLElement>('button, a'),
  });

  // Choosing a destination is not a close: the link navigates to a URL without the marker, the
  // drawer derives itself shut, and useDialogLayer's cleanup releases the scroll lock and focus
  // exactly as a manual close would — while the marker entry survives behind the new screen.
  useEffect(() => { if (!mobileOpen) pushedMenuRef.current = false; }, [mobileOpen]);

  // Crossing into desktop closes the mobile layer so its scroll lock cannot survive a resize.
  // Guarded on the drawer actually being open: this also runs once on mount, and a desktop
  // viewport must not rewrite the URL of every page load. `closeMobileMenu` is stable, so the
  // listener is registered once and reads the live state through the ref.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const sync = () => { if (desktop.matches && mobileOpenRef.current) closeMobileMenu(); };
    desktop.addEventListener('change', sync);
    sync();
    return () => {
      desktop.removeEventListener('change', sync);
    };
  }, [closeMobileMenu]);

  // An open top-nav dropdown closes on outside pointer, on Escape (focus returns to its
  // trigger), and on any route change. One listener set, mounted only while a group is open.
  useEffect(() => {
    if (!openGroup) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!topNavRef.current?.contains(event.target as Node)) setOpenGroup(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      document.getElementById(`top-nav-group-${openGroup}`)?.focus();
      setOpenGroup(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openGroup]);
  useEffect(() => { setOpenGroup(null); }, [location.pathname]);

  /**
   * The phone bar prints the screen name ONLY while the page is not already printing it.
   *
   * The owner asked for the title gone — it duplicates the page's own `<h1>` at the top of every
   * screen, which is where he was looking. Measured before deleting it: of the owner's 27
   * navigation destinations, **22 have no entry in the bottom action bar**, and the back arrow
   * covers only 10 record-screen patterns, names the PARENT rather than the current screen, and
   * carries that name in `aria-label` only — invisible to a sighted person. So on 22 screens
   * "delete the title" means "nothing on the phone says where you are once the page scrolls".
   * Both readings are right, and they are right about different moments: at the top the title is
   * redundant, and once the heading leaves it is the only thing left. So it follows the heading.
   *
   * THE TARGET IS `#main h1.page-title`, which both `PageHeader` and `RecordHeader` render — not
   * a new contract, the one that already exists. `rootMargin` is the bar's own measured height —
   * read at runtime, deliberately not written down here, because it varies with the safe-area
   * inset and measured 69px on the fixture I checked — so the name appears exactly as the heading
   * slides under the bar rather than a bar-height later.
   *
   * REBOUND ON MUTATION, NOT JUST ON ROUTE. Screens return a skeleton first (`if (loading) return
   * <SkeletonCards …>`), so on a fresh route the heading does not exist yet at effect time. A
   * route-only binding would observe nothing, keep the fail-safe, and print the title forever on
   * exactly the screens that load slowest. The `MutationObserver` rebinds when the real heading
   * arrives, and re-checks identity so a re-render does not thrash the observer.
   *
   * NO OBSERVER, NO HEADING, NO ANSWER → SHOW. jsdom has no `IntersectionObserver` and five specs
   * render this shell in it; a screen may legitimately have no `h1`. Both land on the same branch
   * as "the heading is off screen", which is the only branch where being wrong is harmless.
   */
  useEffect(() => {
    setPageHeadingVisible(false);
    if (typeof IntersectionObserver === 'undefined') return;
    const main = document.getElementById('main');
    if (!main) return;
    const barHeight = Math.round(phoneHeaderRef.current?.getBoundingClientRect().height ?? 0);
    /* `undefined` = never bound, `null` = bound to "there is no heading". Starting at `null` made
       the first `bind()` short-circuit on `null === null` and skip its own else branch, so the
       "no heading → name the screen" assignment was dead code on the first pass and only ever ran
       when a heading was REMOVED. Harmless by luck — the effect had just set the same value — and
       invisible to a test, which is how it was found: inverting that branch left the suite green. */
    let observed: Element | null | undefined;
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) setPageHeadingVisible(entry.isIntersecting);
    }, { rootMargin: `-${barHeight}px 0px 0px 0px`, threshold: 0 });
    const bind = () => {
      const heading = main.querySelector('h1.page-title');
      if (heading === observed) return;
      if (observed) seen.unobserve(observed);
      observed = heading;
      if (heading) seen.observe(heading);
      else setPageHeadingVisible(false);
    };
    bind();
    const grown = new MutationObserver(bind);
    grown.observe(main, { childList: true, subtree: true });
    return () => {
      grown.disconnect();
      seen.disconnect();
    };
  }, [location.pathname]);

  // Route changes announce themselves through the tab title and move keyboard focus past the
  // persistent navigation shell. Query-only filter changes keep focus where the user left it.
  // The focus move fires only on an actual pathname change: the title also re-renders when
  // orgName resolves (moments after login) and when currentTitle settles, and stealing focus
  // then blanks the global-search panel mid-typing (its panel lives on :focus).
  const focusedPathRef = useRef<string | null>(null); // null → the mount still focuses #main once
  useEffect(() => {
    document.title = `${currentTitle} — ${orgName ? `${orgName} · ` : ''}${APP_NAME}`;
    if (focusedPathRef.current === location.pathname) return;
    focusedPathRef.current = location.pathname;
    const frame = requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, currentTitle, orgName]);

  // Layout is the single owner of authenticated route titles. Restore the neutral title
  // only when leaving the authenticated shell, never when tenant data finishes loading.
  useEffect(() => () => { document.title = APP_NAME; }, []);

  async function handleSignOut(confirmedWithPendingWork = false) {
    const detail: OrderDraftFlushDetail = { pending: [] };
    window.dispatchEvent(new CustomEvent<OrderDraftFlushDetail>(ORDER_DRAFT_FLUSH_EVENT, { detail }));
    if (detail.pending.length) {
      const saved = await Promise.all(detail.pending);
      if (saved.some((result) => !result)) {
        toast(t('nav.toast'), 'error');
        return;
      }
    }
    // Signing out clears the session, and a receipt still waiting in the device queue can only be
    // sent with a session (`OFFLINE-SYNC-DESIGN.md:87-88`). So it is asked, with the counts named,
    // through ConfirmDialog — never `confirm()`, which cannot be styled, translated or tested.
    if (!confirmedWithPendingWork) {
      const pending = await pendingOfflineWork();
      if (pending.actions > 0 || pending.uploads > 0) {
        setPendingOffline(pending);
        return;
      }
    }
    const result = await signOut();
    if (result.error) {
      toast(errorText(result.error), 'error');
      return;
    }
    navigate('/login');
    if (result.pushWarning) toast(result.pushWarning, 'error');
  }

  /* TWO navigation surfaces, one vocabulary — not three. A `'shell'` variant (dark Onyx rows,
     `bg-shell-ink` active state) survived here until 26.08.2026 with no caller left: T7.3k turned
     the phone drawer into paper (`bg-topbar`) and it renders `'panel'` like every dropdown, while
     the desktop sidebar it was written for became the floating pill in T7.2. Its `.section-glyph`
     accent on the active icon went with it — on the two remaining surfaces the accent equals the
     active pill's own colour, which is why the panel branch already had the icon inherit.
     What is left is what ships: the LIGHT dropdown/drawer row and the floating pill, both marking
     the active item with the small OCEANIC pill — the blue is the marker, the surface is bright. */
/**
   * Three surfaces, because the shell has three grounds.
   *
   * The `'shell'` branch was deleted on 26.08.2026 as dead code — correctly, at the time: the phone
   * drawer had been light paper since T7.3j and nothing passed it. The owner reversed that on
   * 28.08.2026 ("לעשות שהתפריט יהיה בצבע השחור של האפליקציה והמילים בהירות"), so the branch is
   * back and has a caller again. It is NOT the same thing as `'panel'`: the desktop dropdowns and
   * the account menu are light paper by an owner ruling of their own (T7.3h, image #18), and one
   * surface class serving both grounds is how one of them ends up unreadable.
   *
   * THE ACTIVE MARK IS NOT ONE COLOUR ON ALL THREE. On the two light surfaces it is the oceanic
   * pill, and that has not changed. On onyx it is the LIGHT pill — `shell-ink` ground, `shell`
   * ink, the same two tokens the surface already uses, flipped (owner, 28.08.2026: "ההדגשה כחולה
   * בתפריט... שזה יהיה בהיר ולא כחול"). The principle is the constant, not the hue: the mark is
   * whatever contrasts hardest with the ground it sits on, and oceanic against onyx is two dark
   * colours a few points apart.
   */
  const linkCls = (isActive: boolean, surface: NavSurface = 'panel') => {
    if (surface === 'pill') {
      return `relative flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
        isActive ? 'bg-action text-on-solid font-medium' : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
      }`;
    }
    const state = surface === 'shell'
      ? (isActive
        ? 'bg-shell-ink text-shell font-medium'
        : 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink')
      : (isActive
        ? 'bg-action text-on-solid font-medium'
        : 'text-ink-body hover:bg-surface-hover hover:text-ink');
    return `flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${state}`;
  };

  /* Section identity in navigation (T7.2) is DATA here, not decoration: `data-section` rides every
     nav link and `<main>`, and the one visible consumer is `.section-mark` under a page title. The
     pill is TEXT-only, and on the light panel the icon inherits — a `.section-glyph` accent would
     be the active oceanic pill's own colour. So no navigation surface paints the accent. */
  const navLinks = (items: readonly NavItem[], opts?: { surface?: NavSurface }) => items.map((item) => {
    const surface = opts?.surface ?? 'panel';
    const active = isRouteFamilyActive(location.pathname, item.to);
    const section = active ? sectionOf(item.to) : null;
    // The table holds a KEY (module scope cannot call a hook); it is resolved here, where one has.
    const itemLabel = t(item.labelKey);
    return (
      <Link key={item.to} to={item.to} className={linkCls(active, surface)} aria-current={active ? 'page' : undefined}
        data-section={section ?? undefined} data-tour-anchor={tourNavigationAnchor(item.to)}
        onClick={() => setOpenGroup(null)}>
        {surface !== 'pill' && <item.icon size={ICON.md} aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
        {item.to === '/documents' && inboxCount != null && inboxCount > 0 && (
          <span className="badge num bg-action-soft text-action-on-soft ms-auto">{inboxCount}</span>
        )}
        {/* T7.3: no accent underline in the pill — the owner read it as an unexplained color.
            The active oceanic pill alone carries "you are here"; the page-title mark remains
            the accent surface. */}
      </Link>
    );
  });

  /**
   * ONE sign-out control, written once (26.08.2026). The drawer's copy was `text-xs` with a 13px
   * glyph and no horizontal padding; the desktop account menu's was `text-sm`, a 14px glyph and
   * `px-3`. Two treatments of the single most consequential control in the shell is one too many,
   * and the drawer's had a second problem: at `px-1` the account block sat ~35px start-ward of
   * every nav label above it (`px-3`), so the person's own name was the one row in the list that
   * did not line up with the list.
   */
  const signOutRow = (surface: NavSurface = 'panel') => (
    <button type="button" onClick={() => void handleSignOut()}
      className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
        surface === 'shell'
          ? 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
          : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
      }`}>
      <LogOut size={ICON.md} aria-hidden="true" /> {t('layoutTail.signOut')}
    </button>
  );

  const startOwnerTour = () => {
    setOpenGroup(null);
    if (!mobileOpenRef.current) {
      ownerTourRef.current?.start();
      return;
    }
    closeMobileMenu();
    requestAnimationFrame(() => ownerTourRef.current?.start());
  };

  const tourLauncherRow = (surface: NavSurface = 'panel') => (role === 'owner' ? (
    <button type="button" onClick={startOwnerTour}
      className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
        surface === 'shell'
          ? 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
          : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
      }`}>
      <CircleHelp size={ICON.md} aria-hidden="true" /> {t('nav.productGuide')}
    </button>
  ) : null);

  /* The phone's account block — the person, and nothing about the contract.
     The tier mark passed through here for one round and the owner corrected the premise: a plan
     is a property of the TENANT, not of the person signed in, and parking it beside a name and a
     role said the opposite. It now rides the phone header's second line and, on desktop, the
     column under the brand pill — both places where the ORGANISATION is what is being named. */
  const accountBlock = (
    <div className="pt-3">
      <div className="px-3 text-sm font-medium text-shell-ink">{profile?.full_name}</div>
      <div className="mb-2 px-3 text-xs text-shell-ink-dim">{role ? roleLabels[role] : ''}</div>
      {tourLauncherRow('shell')}
      {signOutRow('shell')}
    </div>
  );

  /**
   * The phone drawer, and ONLY the phone drawer (26.08.2026).
   *
   * This helper carried two parameters describing a second caller that no longer exists: the fixed
   * desktop sidebar became the floating top pill in T7.2, so `expandGroups` was always `true` (the
   * `<details>` branch unreachable) and `stickyFooter` always `false` (the pinned bottom strip
   * unreachable). What that strip DID carry is kept: DESIGN.md:509 wants the owner's settings area
   * separated from the destinations, and the rule now rides the drawer's own footer section.
   */
  const sidebar = (displaySections: readonly NavSection[], navLabel: string) => (
    <div className="flex flex-col h-full">
      {/* The mark is a door. Every product trains people that the logo goes home, and here it went
          nowhere — a 40px target in the corner of every screen that silently did nothing. It is a
          Link rather than a decorated div so it lands in the tab order, announces itself and
          honours a middle click; the image stays alt="" because the accessible name belongs to the
          link, and repeating it would make a screen reader say the brand twice. */}
      {/* THE TIER MARK LIVES HERE NOW (owner, 26.08.2026 — he X'd it off the phone bar and circled
          this line). It is the third placement and the first one that agrees with his own stated
          reason from the round before: a plan is a property of the TENANT, and this is the only
          place in the phone shell where the tenant is actually named — under the brand mark, above
          the org name, not beside the person.
          THE ROW IS NO LONGER ONE LINK, and it cannot be: `PlanBadge` is a `<Link>` to
          `/settings/subscription`, and an anchor inside an anchor is invalid HTML that browsers
          resolve by closing the outer one early — the brand link would silently stop covering its
          own text. So the header is a flex row, the home link wraps only the mark and the names,
          and the chip is its sibling. `pe-12` still clears the absolutely-positioned close button,
          which is why the chip lands inside that reserve rather than under the X. */}
      <div className="flex items-center gap-3 border-b border-shell-ink/15 px-4 py-4 pe-12 lg:pe-4">
        {/* The mark is a door. Every product trains people that the logo goes home, and here it went
            nowhere — a 40px target in the corner of every screen that silently did nothing. It is a
            Link rather than a decorated div so it lands in the tab order, announces itself and
            honours a middle click; the image stays alt="" because the accessible name belongs to
            the link, and repeating it would make a screen reader say the brand twice. */}
        <Link to="/dashboard" aria-label={t('layoutTail.homeAria', { app: APP_NAME })}
          className="-m-2 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 hover:bg-shell-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset">
          {brandMark('drawer')}
          <div className="min-w-0">
            <div className="text-base font-semibold text-shell-ink">{APP_NAME}</div>
            <div className="truncate text-xs text-shell-ink-dim" title={orgName || undefined}>{orgName || t('nav.text_9')}</div>
          </div>
        </Link>
        <PlanBadge compact />
      </div>
      <nav aria-label={navLabel} className="scrollbar-hidden flex-1 overflow-y-auto px-3 py-3">
        {/* Every group open, always. DESIGN.md settles the three-way contradiction this file used
            to carry: a destination behind a lid is a destination people stop finding. */}
        {displaySections.map((s, i) => (
          /* THE RULE IS THE WHOLE DEVICE (owner, 28.08.2026: "אין צורך בפסי הפרדה לשים עוד טקסט -
             הפסי הפרדה מספיקים"). The first version of this separation drew a rule AND printed the
             group's name on it; he removed the word. He is right about what the word was doing:
             the rows underneath already say רכש or כספים by being ספקים and חשבוניות, so the
             heading repeated the list in a smaller, greyer font and cost a line per group on the
             surface with the least room. The line alone answers the only question a heading was
             answering here — where does one subject end and the next begin.
             The group NAMES are not deleted; they still name the desktop dropdowns, where a
             collapsed trigger genuinely has nothing else to say. */
          <div key={s.section || i}
            className={i > 0 ? 'mt-2 border-t border-shell-ink/15 pt-2' : ''}>
            <div className="space-y-0.5">{navLinks(s.items, { surface: 'shell' })}</div>
          </div>
        ))}
        {/* On a phone the account block travels WITH the menu instead of pinning to the bottom.
            The drawer is 100dvh of overlay: a fixed strip there is a second bar competing with the
            list scrolling behind it, and on a short viewport it ate the last destinations.
            The rule above it is the separation DESIGN.md:509 asks for — the owner's settings area
            is not one more work destination — and it is drawn here rather than by a pinned strip.
            The note trigger sits with the account because the phone top bar gave its slot to the
            tier mark (owner report 25.08.2026): it goes nowhere, it opens a dialog. */}
        <div className="mt-2 border-t border-shell-ink/15 pt-3">
          <FeedbackButton variant="menu" tone="shell" />
          {accountBlock}
        </div>
      </nav>
    </div>
  );

  /* ---- T7.1 desktop top navigation (owner decision, reference layout) ----
     The fixed sidebar became a top bar: brand at the logical start, navigation in the middle,
     search / bell / feedback / account at the end. The 19 owner destinations do not fit one row,
     so each named NAV_SECTIONS group becomes a disclosure dropdown (aria-expanded button + the
     same navLinks inside a dark panel); the unnamed first group's links stay top-level. The
     active LINK keeps the paper pill + section glyph — same language as before; a group that
     contains the active screen marks its trigger. Mobile (<lg) is untouched. */
  const groupContainsActive = (items: readonly NavItem[]) =>
    items.some((item) => isRouteFamilyActive(location.pathname, item.to));
  /* Pill-surface group trigger (T7.3): the group holding the active screen wears the same small
     OCEANIC pill as an active item. T7.3i (owner, image #21): an OPEN group wears the deep
     oceanic pill too — the trigger of the opened panel is the blue marker. */
  const groupTriggerCls = (active: boolean, open: boolean) =>
    `relative flex min-h-10 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
      active || open ? 'bg-action text-on-solid font-medium' : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
    }`;
  /* `holdsInboxLink` stood here until 26.08.2026, mirroring the unfiled-documents count onto a
     group trigger when the group contained `/documents`. No group ever can: `/documents` is daily
     work and lives in the UNNAMED leading section for both roles that hold it, so the condition
     was constant false. The count still renders where it is true — on the link itself, in the
     drawer, and now on the phone action bar. */
  const topNavGroup = (s: NavSection) => {
    const open = openGroup === s.section;
    const active = groupContainsActive(s.items);
    return (
      <div key={s.section} className="relative">
        <button type="button" id={`top-nav-group-${s.section}`} aria-expanded={open}
          className={groupTriggerCls(active, open)}
          onClick={() => setOpenGroup(open ? null : s.section)}>
          <span className="whitespace-nowrap">{s.section ? t(s.section) : ''}</span>
          <ChevronDown size={ICON.xs} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {/* Mounted always, hidden when closed: the active link keeps existing in the DOM (the
            accessibility contract in layoutActiveState.spec queries it), and reopening costs
            nothing. `hidden` removes it from the a11y tree and the tab order while closed.
            T7.3h (owner, image #18): the panel is LIGHT paper — dark ink items, the active one
            marked by the small oceanic pill ("בהיר עם סימון כחול"). */}
        <div hidden={!open} className="absolute start-0 top-full z-50 mt-2 w-64 rounded-2xl bg-surface p-2 shadow-menu ring-1 ring-line-soft">
          <div className="space-y-0.5">{navLinks(s.items, { surface: 'panel' })}</div>
        </div>
      </div>
    );
  };
  const accountOpen = openGroup === 'account';
  // The reference's account affordance: an avatar circle on the background. Initials on an
  // OCEANIC disc (T7.3 — the blue leads); the menu is the same deep-oceanic panel.
  const topAccountMenu = (
    <div className="relative">
      <button type="button" id="top-nav-group-account" aria-expanded={accountOpen}
        aria-label={t('layoutTail.accountMenu', { name: profile?.full_name || t('layoutTail.user') })}
        className={`rounded-full shadow-card transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${accountOpen ? 'scale-95' : 'hover:scale-105'}`}
        onClick={() => setOpenGroup(accountOpen ? null : 'account')}>
        {/* `tone="action"` and not a seed: there is one signed-in person on the screen, so the
            disc identifies a ROLE rather than a member, and T7.3 fixed that in the oceanic. */}
        <EntityMonogram name={profile?.full_name ?? ''} tone="action" size="lg" />
      </button>
      {/* Mounted always, hidden when closed — same reasoning as the nav groups: the settings
          link must exist for the active-state contract even while the menu is shut.
          T7.3h: light paper panel, same as the nav dropdowns.

          `data-no-capture` (26.08.2026) is load-bearing the moment the note trigger moves in here,
          and it is NOT the same guard the drawer gets for free. The phone drawer is
          `role="dialog"`, which `SKIP_SELECTOR` in `lib/screenshot.ts` already skips; this panel is
          a plain div, so without this attribute a note sent from the account menu would arrive as
          a photograph of the account menu — the exact failure the drawer placement was designed
          around, in different clothing.
          The panel does NOT need to close first, and must not: `Modal` portals to the document
          root, so the dialog is not a descendant of this box, and `hidden` here can never hide it.
          The phone's first attempt at this closed the drawer and unmounted the component
          mid-click; nothing here unmounts, because `hidden` is not removal. */}
      <div hidden={!accountOpen} data-no-capture className="absolute end-0 top-full z-50 mt-2 w-64 rounded-2xl bg-surface p-3 shadow-menu ring-1 ring-line-soft">
        <div className="text-sm font-medium text-ink">{profile?.full_name}</div>
        <div className="text-xs text-ink-muted">{role ? roleLabels[role] : ''}{orgName ? ` · ${orgName}` : ''}</div>
        {footerItems.length > 0 && <div className="mt-2 space-y-0.5">{navLinks(footerItems, { surface: 'panel' })}</div>}
        {/* The same row the drawer shows, in the surface that IS the drawer on this width. */}
        <div className="mt-2"><FeedbackButton variant="menu" /></div>
        {role === 'owner' && <div className="mt-2">{tourLauncherRow()}</div>}
        <div className="mt-2">{signOutRow()}</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh min-w-0">
      {/* T7.3f: the pointer's oceanic wash drifts on the background itself (.app-glow, fixed,
          z -1) over a static pure-wheat canvas — no static color base under it, no card
          spotlights. T7.3i: the dashboard hero band is gone — every screen shares this. */}
      <div aria-hidden="true" className="app-glow no-print" />
      {/* Skip-to-content (audit round 2): the first focusable element, so a keyboard user can
          jump past the navigation bar straight to the page. Hidden until focused, then styled
          like a primary button at the logical start, z-above the top bar (z-40). */}
      <a href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 focus:rounded-lg focus:bg-action focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-on-solid focus:shadow-menu focus:outline-none focus:ring-2 focus:ring-focus">
        {t('nav.text_11')}
      </a>
      {/* Desktop navigation (T7.2, reference layout) — no bar. Floating pills on the glowing
          canvas: an outlined logo pill at the start, a centered WHITE pill holding the text-only
          navigation (active item = small dark pill + accent underline), and at the end the search
          pill, bell, feedback and the avatar disc — sitting straight on the background. */}
      <header ref={topNavRef} className="hidden lg:block sticky top-0 z-40 bg-topbar/75 backdrop-blur-sm no-print">
        <div className="mx-auto flex min-h-[4.25rem] max-w-[1400px] items-center gap-3 px-4 py-2">
          {/* THE TIER MARK IS NOT HERE, and it was, for one round (owner, 26.08.2026: first "מתחת
              ללוגו של המותג", then — looking at it — the greeting line instead). Under the pill it
              floated in dead space between the header and the page, belonging to neither. It now
              rides the dashboard's title block (`Dashboard.tsx`), which is the same slot the phone
              gives it: the line directly under the screen title. What survives from the first
              ruling is the negative — it must NOT stand with the account controls, because there
              it described the person instead of the tenant.
              It also cost the navigation 19px of the row while it was here, which is 19px the
              1100px band did not have. */}
          <Link to="/dashboard" aria-label={t('layoutTail.homeAria', { app: APP_NAME })}
            /* HEIGHT PINNED TO THE SEARCH FIELD, not left to the padding (owner: "הבועה צריכה
               להתאים בגודלה לאותו גודל של התיבת חיפוש"). `.input` is `min-h-11`; `h-11` here is
               the same 44px from the same token, so the two ends of the row cannot drift apart
               when the mark inside changes. `min-w-11` keeps it a circle below 2xl, where it
               holds the mark alone; the end padding belongs to the WORD and only exists where
               the word does. */
            className="flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full bg-surface/85 px-1.5 shadow-card ring-1 ring-line-soft transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus 2xl:pe-4">
            {/* 28px, down from 32 (owner: "תקטין את הגודל של הלוגו"). This pill is now the ONLY
                bar carrying the mark — the owner crossed it off the phone and tablet header the
                same day — and the drawer, which has a whole row to itself, runs it at 32. */}
            {brandMark('bar')}
            {/* The product word costs 62px, and between 1280 and 1535 that is the difference
                between one navigation row and two (measured 26.08.2026, owner account). The MARK
                is the home link at every width and `aria-label` still carries the name. */}
            <span className="hidden text-sm font-semibold text-ink 2xl:block">{APP_NAME}</span>
          </Link>
          {/* The row's three blocks are logo · navigation · utilities, and the outer two are
              `shrink-0`. Until 26.08.2026 the middle one could not shrink either — a flex item's
              default `min-width: auto` plus `whitespace-nowrap` children — so at 1024 the owner's
              nav simply overflowed its container and pushed the logo clean off the start edge,
              with the first destination clipped by the viewport. The figures this once carried,
              "739px natural, 531px available", were a snapshot of that day's utilities cluster and
              are no longer either quantity: the nav measures 723px natural today (nine items,
              unchanged) and 1024 now has 635px available, because the note trigger and the tier
              mark left the end cluster. Kept as history, not as constants.
              `min-w-0` + `flex-wrap` is the fix: the pill takes a second line when the row cannot
              hold it rather than evicting the brand. Nothing is hidden, nothing scrolls, and no
              destination was removed to make it fit. Measured after: one row from 1280 up. */}
          <div className="flex min-w-0 flex-1 justify-center">
            <nav aria-label={t('nav.aria_label')} data-tour-anchor="primary-navigation"
              /* `rounded-[1.625rem]` IS `rounded-full` for the row this pill actually is, and it is
                 not a compromise: 26px is exactly half the one-row height (p-1.5 = 12 + a 40px
                 `min-h-10` item = 52), so at every width that fits on one line — 1152 and up,
                 measured — this renders pixel-for-pixel as the capsule it has always been.
                 What changes is the wrap. `rounded-full` on a 94px two-row box resolves to a 47px
                 radius and the pill balloons into a lozenge with items floating inside the curve;
                 that is what the owner saw and called "גולש". At 26px the same two rows read as a
                 contained panel that meant to have two rows. */
              className="flex min-w-0 flex-wrap items-center justify-center gap-0.5 rounded-[1.625rem] bg-surface/90 p-1.5 shadow-card ring-1 ring-line-soft backdrop-blur">
              {sections.map((s) => (
                // A NAMED group holding exactly one destination is not a disclosure — DESIGN.md:507,
                // "דיסקלוזר מעל פריט אחד הוא דלת עם מכסה". That is 'המנוי' for an owner and 'ניהול'
                // for an accountant: both were a button, a chevron and a panel over a single link.
                // The group's name is kept as the link's short label (NAV_SHORT_LABELS) so the word
                // on the bar does not change, only the number of clicks to reach the screen.
                !s.section || s.items.length === 1
                  ? <div key={s.section || 'primary'} className="flex flex-wrap items-center justify-center gap-0.5">{navLinks(s.items, { surface: 'pill' })}</div>
                  : topNavGroup(s)
              ))}
            </nav>
          </div>
          {/* ONE end-cluster, one order, both surfaces (owner, 26.08.2026: "צריך להיות מסודר
              מחדש והסדר צריך להיות תואם למובייל"). From the logical start:
              חיפוש · עוזר · פעמון · חשבון. The phone renders the first THREE of exactly that
              sequence and stops — it has no account disc, because on a phone the account is the
              drawer. Nothing is reordered between the two and nothing is grouped differently.
              What left this cluster and why:
              · שליחת הערה → the account menu, where it already lives on the phone (drawer). The
                25.08.2026 ruling now holds on BOTH surfaces instead of only one.
              · דרגת המנוי → under the brand pill. It described the tenant while standing next to
                the person's avatar. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/* The TRIGGER stays compact; the results panel no longer inherits its width (see
                GlobalSearch — a row there carries icon + title + subtitle + badge + money). */}
            {/* THREE widths, because the band that has to pay for the tier mark is a real band.
                The utilities cluster and the logo are `shrink-0`, so every pixel this trigger takes
                comes out of the navigation pill's line budget — and between 1024 and 1279 that
                pill is already wrapping (the documented trade-off: it takes a second line rather
                than evict the brand). Admitting the tier mark at `w-44` pushed 1024 from two lines
                to THREE and the sticky header from 110px to 152px, measured. At `w-32` the trigger
                still reads as a search field and the band is back to two. Nothing is lost with it:
                the results panel stopped inheriting this width (see below), and ⌘K reaches it. */}
            {canSearch && <div data-tour-anchor="global-search" className="w-32 xl:w-44 2xl:w-64 [&_input]:rounded-full [&_input]:bg-surface/90"><GlobalSearch /></div>}
            {/* Self-gated on assistant.ui (fail-closed); renders nothing while the flag is off. */}
            <AssistantPanel session={assistantSession} />
            <NotificationBell />
            {topAccountMenu}
          </div>
        </div>
      </header>

      {/* Mobile top bar */}
      {/* T7.3j: the phone shell joins the desktop language — cool-gray translucent bar, paper
          drawer with the oceanic active pill. */}
      <header ref={phoneHeaderRef} className="phone-safe-header lg:hidden sticky top-0 z-40 bg-topbar/75 backdrop-blur-sm text-ink border-b border-line-soft flex min-w-0 items-center no-print">
        {/* `btn-ghost btn-icon` rather than a fourth hand-written spelling of 44px. The audit
            counted `size-[44px]`, `min-h-11 min-w-11`, `min-h-[44px] min-w-[44px]` and `size-11`
            in this one shell, all meaning the same thing. */}
        <button type="button"
          data-tour-anchor="primary-navigation"
          className="btn-ghost btn-icon group rounded-full"
          onClick={openMobileMenu} aria-label={t('nav.aria_label_2')} aria-expanded={mobileOpen} aria-controls="mobile-navigation">
          {/* The three lines fold into an X while the drawer comes in (owner, 26.08.2026, with the
              reference component). It is drawn here rather than taken from lucide because lucide
              ships `Menu` and `X` as two finished icons, and the thing being asked for is the
              TRANSITION between them — three strokes that rotate and meet, which needs the three
              strokes to be the same three nodes in both states.

              The state comes from `aria-expanded` on the button, not from a second prop: the
              attribute already has to be correct for assistive tech, so binding the animation to
              it makes a wrong icon and a wrong announcement the same bug instead of two.
              `group-aria-expanded:*` is what reads it, so the button carries `group`.

              The two outer lines translate 7px out and rotate 315°/135° back through centre; the
              middle one only rotates 45° and lands under the first, which is why its easing
              overshoots more (the reference's own numbers, kept). `transition-*` and not an
              animation, so the reverse plays for free on close. Reduced motion is handled with
              every other transition in index.css's `prefers-reduced-motion` block. */}
          <svg viewBox="0 0 24 24" width={ICON.xl} height={ICON.xl} fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="menu-toggle pointer-events-none" aria-hidden="true">
            <path d="M4 12L20 12" className="origin-center -translate-y-[7px] transition-all duration-300 [transition-timing-function:cubic-bezier(.5,.85,.25,1.1)] group-aria-expanded:translate-y-0 group-aria-expanded:rotate-[315deg]" />
            <path d="M4 12H20" className="origin-center transition-all duration-300 [transition-timing-function:cubic-bezier(.5,.85,.25,1.8)] group-aria-expanded:rotate-45" />
            <path d="M4 12H20" className="origin-center translate-y-[7px] transition-all duration-300 [transition-timing-function:cubic-bezier(.5,.85,.25,1.1)] group-aria-expanded:translate-y-0 group-aria-expanded:rotate-[135deg]" />
          </svg>
        </button>
        {/* `h-11`, not `min-h-11`: the row's contents CHANGE as the page scrolls, and a bar that
            grows under a moving finger is worse than either state on its own. A fixed 44px is the
            touch floor the hamburger and the action icons already impose, so pinning it costs
            nothing and makes the height unable to move. Measured across the transition, not only
            at its endpoints: 27 samples, one value. */}
        <div className="mobile-shell-identity flex h-11 min-w-0 flex-1 items-center px-2">
          {/* WHAT IS LEFT IN THIS ROW, AND WHY IT IS NEARLY EMPTY (owner, 26.08.2026, third
              pass over this bar). He crossed out the tier chip and the brand mark on the phone and
              tablet bar. Both had a reason to be here an hour ago and neither survives his mark:
              the chip identifies the TENANT and now does that in the drawer header, where the
              tenant is actually named; the mark is a home link that the drawer header and the
              bottom action bar both already carry.
              So AT REST this row holds nothing at all on a top-level screen — the page's own
              <h1> is directly below it saying the same thing, which is the duplication he objected
              to in the first place. It fills only once that heading scrolls under the bar, and
              then with one thing: where you are.

              THE BACK ARROW IS NOT A MARK AND DOES NOT LEAVE. It is the primary way out of a
              record screen and it is a control, so it holds the lead cell at every scroll
              position. It is the only occupant that survived this pass.

              WHAT THE ROW STOPPED DOING. Until this ruling the name arrived by pushing a chip
              toward the end of the row — one motion, one cause. With nothing left to push, that
              choreography has no subject: the lead cell's collapsing `max-width`, the trailing
              cell and its per-role branching are all deleted rather than left running on an empty
              row. What remains is the reveal itself, two tracks wide, because the name still has
              to arrive from somewhere and a title that simply blinks into a sticky bar mid-scroll
              reads as a glitch. `0fr` -> `1fr` wipes it in from the leading edge, which under
              `dir="rtl"` is out from behind the menu button.

              LOGICAL AXIS, NOT `translate`. `translate-x` is physical: it does not mirror under
              `dir="rtl"` and would send the name the wrong way. Grid tracks run along the inline
              axis, so this needs no direction test and no second code path. */}
          <div
            className={`grid h-11 min-w-0 flex-1 items-center transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none ${
              pageHeadingVisible ? 'grid-cols-[auto_0fr]' : 'grid-cols-[auto_1fr]'
            }`}
            data-shell-identity={pageHeadingVisible ? 'quiet' : 'screen'}>
            {/* Empty on a top-level screen, which costs nothing: an `auto` track with no content
                measures zero, so the name starts flush against the menu button. */}
            <div data-shell-lead>
              {routeBack && (
                <Link to={routeBack.to} aria-label={t(routeBack.label)} title={t(routeBack.label)}
                  className="btn-ghost btn-icon rounded-full">
                  <ArrowRight size={ICON.xl} aria-hidden="true" />
                </Link>
              )}
            </div>
            {/* Always mounted — a track cannot animate from nothing — and taken out of the
                accessibility tree while it has no width, because in that state the page's own
                `<h1>` is the authoritative copy and exposing both is reading the screen name
                twice. */}
            <div className="min-w-0 overflow-hidden">
              <span data-shell-title aria-hidden={pageHeadingVisible}
                className="block truncate text-sm font-semibold" title={currentTitle}>{currentTitle}</span>
            </div>
          </div>
        </div>
        {/* T7.3k (owner, images #33-34 "אתה רואה את ההבדלים בשפה?"): the desktop language —
            bare round icon targets in dark ink straight on the bar, no boxed cluster. */}
        {/* THREE marks beside the title, and the rule that decides which three (owner, 26.08.2026:
            "זה צפוף מידי צריך לחשוב מה להוריד מה להשאיר במובייל"). The same test that moved the
            note trigger out on 25.08.2026 — how often is it used, and does it exist anywhere else
            — is what moves the TIER MARK out now, because on 25.08 it was applied to three
            candidates and the fourth was the one being let in.
            · חיפוש stays: on a phone this icon is the ONLY door to it. There is no ⌘K.
            · פעמון stays: it is the only place the unread count is stated at all, and a count
              you have to open a menu to see is a count nobody reads.
            · העוזר stays: it opens a surface that exists nowhere else in the phone shell.
            · דרגת המנוי goes: it is the one STATUS in a row of doors, the rarest thing a person
              needs (you check which plan you are on monthly, not hourly), and the only one already
              one tap away — the drawer's 'המנוי' group, and now the account block itself, where a
              plan belongs beside the name and the role. It was also the loudest colour here.
            Measured at 390px, owner account: four targets left the title 30px of a 76px word and
            it rendered "מר…". */}
        {/* `mobile-shell-actions` was a class name with no rule anywhere in the stylesheet, like
            `mobile-shell-subtitle` on the line above. Its sibling `mobile-shell-identity` is real
            and still carries a narrow-phone rule, which is what made the dead ones look
            load-bearing.
            `mobile-shell-mark` WAS the third real one and is now the fourth dead one: the owner
            removed the mark from this bar on 26.08.2026, so nothing wears that class any more and
            its `@media (max-width: 22.499rem) { display: none }` rule in `index.css` can never
            match. The rule is the integrator's to delete — reported, not silently orphaned. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {canSearch && (
            <button type="button" className="btn-ghost btn-icon rounded-full" onClick={() => setSearchOpen(true)}
              data-tour-anchor="global-search"
              aria-label={t('nav.aria_label_3')} aria-expanded={searchOpen} aria-controls="mobile-global-search"><Search size={ICON.xl} aria-hidden="true" /></button>
          )}
          <AssistantPanel session={assistantSession} />
          <NotificationBell />
        </div>
      </header>
      {searchOpen && <GlobalSearch variant="mobile" onClose={() => setSearchOpen(false)} />}
      {/* T7.3k (owner, image #35): neutral dark scrim — the oceanic one read as a strange
          blue tint over the page.

          `data-no-capture` (25.08.2026): the feedback note photographs the viewport, and this
          scrim is a half-opaque sheet over all of it. The panel inside is already skipped by the
          capture because it is `role="dialog"`; the scrim is not, and without this a note sent
          from the menu would arrive as a picture of the screen behind a grey wash. */}
      {/* `drawer-scrim` / `drawer-enter` (26.08.2026). Not decoration: the drawer covers the whole
          viewport INCLUDING the trigger, so with an instant mount the icon's fold to an X happened
          behind an opaque sheet and nobody ever saw it. 280ms of travel is the window in which the
          animation the owner asked for is actually on screen. Entry only — React unmounts the
          subtree on close, so there is no exit to animate, and adding a presence library to buy
          one is not worth a frame of drawer. */}
      {mobileOpen && (
        <div data-no-capture className="drawer-scrim lg:hidden fixed inset-0 z-50 bg-shell/50 no-print" onClick={() => closeMobileMenu()}>
          {/* ONYX, with light words (owner, 28.08.2026: "לעשות שהתפריט יהיה בצבע השחור של
              האפליקציה והמילים בהירות"). The drawer was light paper from T7.3j and is the app's
              own dark again — opaque, never translucent: T7.3k already recorded that translucency
              here blends with the scrim and the page behind it and reads as a murky blue tint. */}
          <aside id="mobile-navigation" ref={drawerRef} role="dialog" aria-modal="true" aria-label={t('nav.aria_label_4')}
            tabIndex={-1} className="drawer-enter phone-safe-drawer absolute inset-y-0 start-0 w-72 bg-shell text-shell-ink focus:outline-none" onClick={(e) => e.stopPropagation()}>
            {/* Positioned INSIDE the safe-area padding, not on top of it. `absolute top-2 end-2`
                measured from the panel's border box, so on a notched device the drawer's
                `padding-block-start: env(safe-area-inset-top)` slid the list down and left the
                close button sitting under the notch. The phone header solves the same problem with
                `max(0.75rem, env(safe-area-inset-top))`; this does it with the same expression. */}
            <button type="button" className="btn-ghost btn-icon absolute end-2 rounded-full text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink" style={{ insetBlockStart: 'max(0.5rem, env(safe-area-inset-top))' }}
              onClick={() => closeMobileMenu()} aria-label={t('nav.aria_label_5')}><X size={ICON.lg} aria-hidden="true" /></button>
            {sidebar(drawerSections, t('nav.sidebar'))}
          </aside>
        </div>
      )}

      {/* The utility header merged into the top bar (T7.1); search/bell/feedback live there now. */}
      {accessStatus !== 'unknown' && organizationAccess.mode === 'read_only' && (
        <div role="alert" className="no-print border-b border-alert-line bg-alert-wash px-4 py-3 text-sm text-alert-fg lg:px-6">
          {t('nav.text_12')}
        </div>
      )}
      {accessStatus !== 'unknown' && organizationAccess.mode === 'offboarding' && (
        <div role="alert" className="no-print border-b border-alert-line bg-alert-wash px-4 py-3 text-sm text-alert-fg lg:px-6">
          {t('nav.text_13')}
        </div>
      )}
      {/* Content — id/tabIndex are the skip-link target; focus lands here without a ring.
          `data-section` is the paper half of the section identity and the ONLY place the accent
          enters the working area: it resolves `--section-accent` for everything below it, which
          today means the short rule under the page title (`.section-mark`). It is set from the
          URL, never from data, so no screen can turn it into a status; a screen with no work
          domain (/dashboard, the בקרה screens, settings) simply carries no attribute and the
          mark stays hidden. */}
      <main id="main" tabIndex={-1} data-section={sectionOf(location.pathname) ?? undefined}
        className="phone-safe-main min-w-0 pt-5 focus:outline-none">
        {/* max-w column centred (mx-auto) under the top bar — the same 1400px measure the bar
            itself uses, so navigation and content share one grid. keyed by path so each screen
            change re-triggers the fade (section 11). */}
        <div key={location.pathname} className="page-fade mx-auto min-w-0 max-w-[1400px]">
          <Outlet />
        </div>
      </main>

      {/* Role-aware quick actions — the phone bar. The component self-gates by role and by write
          access; Layout never wraps public pages. The unfiled-documents count is handed down
          rather than queried a second time — this shell already holds the live value. */}
      <Fab inboxCount={inboxCount} />

      <OwnerProductTour ref={ownerTourRef}
        profile={profile && role ? { id: profile.id, org_id: profile.org_id, role } : null}
        onPrepareStep={prepareOwnerTourStep} />

      {/* Unsynced receiving work + logout. The counts are named rather than summarised: "2 פעולות"
          and "1 העלאה" are different work, and a person deciding whether to sign out on a phone
          with no signal needs to know which of the two they are about to leave behind. */}
      <ConfirmDialog open={pendingOffline !== null} danger
        title={t('nav.title')}
        message={pendingOffline
          ? t('layoutTail.pendingOffline', { actions: pendingOffline.actions, uploads: pendingOffline.uploads })
            + ' '
            + t('nav.text_14')
            + ' '
            + t('nav.text_15')
          : ''}
        confirmLabel={t('nav.confirmLabel')}
        onClose={() => setPendingOffline(null)}
        onConfirm={() => { setPendingOffline(null); void handleSignOut(true); }} />
    </div>
  );
}
