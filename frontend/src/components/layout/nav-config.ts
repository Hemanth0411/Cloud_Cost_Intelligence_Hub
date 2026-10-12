import {
  Activity,
  Bell,
  Building2,
  Cloud,
  GitCompare,
  Layers,
  LayoutDashboard,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** False until the page is implemented; shown with a "Soon" tag. */
  ready: boolean;
  /** Shows a live counter next to the label. */
  badge?: 'alerts';
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
      { label: 'Providers', href: '/providers', icon: Cloud, ready: true },
      { label: 'Accounts', href: '/accounts', icon: Building2, ready: true },
      { label: 'Services', href: '/services', icon: Layers, ready: true },
      { label: 'Comparison', href: '/compare', icon: GitCompare, ready: true },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'Anomalies', href: '/anomalies', icon: Activity, ready: true },
      { label: 'AI Insights', href: '/insights', icon: Sparkles, ready: true },
      { label: 'Alerts', href: '/alerts', icon: Bell, ready: true, badge: 'alerts' },
    ],
  },
  {
    label: 'Admin',
    items: [{ label: 'Settings', href: '/settings', icon: Settings, ready: true }],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function findNavItem(pathname: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
}
