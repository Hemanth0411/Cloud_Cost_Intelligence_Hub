'use client';

import { ChevronDown, LogOut } from 'lucide-react';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { signOut } from '@/lib/services/session-service';
import { useSession } from '@/hooks/use-session';

const initials = (name: string): string =>
  name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export function UserMenu() {
  const { user } = useSession();

  /**
   * Delegated to session-service, not done here.
   *
   * Clearing the cookie and pushing to /login is enough in mock mode
   * and is NOT signing out in live mode: Cognito holds its own session,
   * so the next authorize request returns a code with no prompt and the
   * user is immediately back in. session-service redirects through
   * Cognito's /logout, which is why this is a full navigation rather
   * than a router push.
   */
  function handleSignOut(): void {
    signOut();
  }

  return (
    <DropdownMenu
      label="Account menu"
      triggerClassName="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      trigger={
        <>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground" aria-hidden>
            {user ? initials(user.name) : ''}
          </span>
          <span className="hidden text-left leading-tight sm:block">
            <span className="block text-sm font-medium">{user?.name ?? '\u00A0'}</span>
            <span className="block text-[11px] text-muted-foreground">{user?.role ?? '\u00A0'}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </>
      }
    >
      <DropdownMenuLabel>
        <span className="block text-sm font-medium text-foreground">{user?.name}</span>
        <span className="block">{user?.email}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem icon={<LogOut className="h-4 w-4" />} onSelect={handleSignOut} destructive>
        Sign out
      </DropdownMenuItem>
    </DropdownMenu>
  );
}
