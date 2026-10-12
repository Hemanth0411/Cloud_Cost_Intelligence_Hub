import { Compass } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-3 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Compass className="h-6 w-6" aria-hidden />
      </span>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">That page does not exist. Use the links below to get back on track.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link href="/dashboard" className={cn(buttonVariants())}>Go to dashboard</Link>
        <Link href="/login" className={cn(buttonVariants({ variant: 'outline' }))}>Sign in</Link>
      </div>
    </div>
  );
}
