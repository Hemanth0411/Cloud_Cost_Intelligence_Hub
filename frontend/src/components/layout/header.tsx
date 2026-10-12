'use client';

import { CircleDot, Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { NotificationBell } from '@/components/alerts/notification-bell';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import { getFilterOptions } from '@/lib/services/cost-service';
import { findNavItem } from './nav-config';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

export function Header({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const pathname = usePathname();
  const current = findNavItem(pathname);
  const { dataEnd } = getFilterOptions();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobileNav} aria-label="Open navigation">
        <Menu className="h-5 w-5" />
      </Button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
        <span className="hidden text-muted-foreground sm:inline">CloudLens</span>
        <span className="hidden text-muted-foreground sm:inline">/</span>
        <span className="truncate font-medium">{current?.label ?? 'Dashboard'}</span>
      </nav>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <div className="hidden items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground md:flex">
          <CircleDot className="h-3 w-3 text-success" aria-hidden />
          Demo data · through {formatDate(dataEnd, 'medium')}
        </div>
        <NotificationBell />
        <ThemeToggle />
        <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
        <UserMenu />
      </div>
    </header>
  );
}
