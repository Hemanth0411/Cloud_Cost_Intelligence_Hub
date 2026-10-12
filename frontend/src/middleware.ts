import { NextResponse, type NextRequest } from 'next/server';
import { GUEST_ONLY_PATHS, PUBLIC_PATHS, SESSION_COOKIE } from '@/lib/auth/constants';

const isIn = (list: readonly string[], pathname: string): boolean => list.includes(pathname);

/**
 * Mock route guard. Public pages (sign in, register, forgot/reset password) are open; every other page
 * needs the demo session cookie. Signed-in users are bounced away from the guest-only pages.
 */
export function middleware(request: NextRequest): NextResponse {
  const hasSession = request.cookies.has(SESSION_COOKIE);
  const { pathname } = request.nextUrl;

  if (isIn(PUBLIC_PATHS, pathname)) {
    return hasSession && isIn(GUEST_ONLY_PATHS, pathname)
      ? NextResponse.redirect(new URL('/dashboard', request.url))
      : NextResponse.next();
  }

  if (!hasSession) {
    const url = new URL('/login', request.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
