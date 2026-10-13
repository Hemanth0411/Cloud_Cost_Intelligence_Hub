import {
  Activity,
  Bell,
  Building2,
  Cloud,
  GitCompare,
  Layers,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** False until the page is implemented; shown with a "Soon" tag. */
  ready: boolean;
  /**
   * The page describes a capability nothing is wired to.
   *
   * NOT the same as `ready: false`, which means "coming". This means
   * "this is a design and the backend for it does not exist", so it
   * is labelled permanently rather than optimistically -- the whole
   * point being that someone clicking it is told before they read
   * the numbers, not after.
   *
   * `'mock'` means it is a concept only while the app is on mock data,
   * and wired to a real endpoint in live mode.
   */
  concept?: boolean | 'mock';
  /** Shows a live counter next to the label. */
  badge?: 'alerts';
  /**
   * Hidden from non-superadmins. Hiding, not disabling -- a disabled
   * link still tells you the page exists.
   *
   * This is convenience, NOT access control: the API returns 403 for a
   * non-superadmin whatever the sidebar renders.
   */
  superadminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, ready: true }],
  },
  {
    label: 'Explore',
    items: [
      { label: 'Accounts', href: '/accounts', icon: Building2, ready: true },
      { label: 'Services', href: '/services', icon: Layers, ready: true },
      { label: 'Comparison', href: '/compare', icon: GitCompare, ready: true },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'Anomalies', href: '/anomalies', icon: Activity, ready: true },
      // A concept in MOCK mode only: there the page is a rule pass over the
      // invented dataset. Live, it reads GET /insights and is real.
      { label: 'AI Insights', href: '/insights', icon: Sparkles, ready: true, concept: 'mock' },
      { label: 'Alerts', href: '/alerts', icon: Bell, ready: true, badge: 'alerts' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Users & grants', href: '/admin/users', icon: ShieldCheck, ready: true, superadminOnly: true },
      { label: 'Cloud accounts', href: '/admin/connections', icon: Cloud, ready: true, superadminOnly: true },
      { label: 'Audit log', href: '/admin/audit', icon: ScrollText, ready: true, superadminOnly: true },
      { label: 'Settings', href: '/settings', icon: Settings, ready: true },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The groups a given role should see, with empty groups dropped.
 *
 * Returning filtered groups rather than a flag per item keeps the
 * filtering in one place -- the sidebar renders whatever it is handed,
 * so a future role cannot accidentally leak a link by forgetting a
 * check at the render site.
 */
export function navGroupsFor(isSuperadmin: boolean): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.superadminOnly || isSuperadmin),
  })).filter((group) => group.items.length > 0);
}

export function findNavItem(pathname: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
}
