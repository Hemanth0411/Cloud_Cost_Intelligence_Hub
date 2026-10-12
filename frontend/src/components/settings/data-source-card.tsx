'use client';

import { Database, Radio, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  BUILD_DEFAULT_IS_MOCK,
  isMock,
  liveBlockedBy,
  modeSource,
  setMockOverride,
  type ModeSource,
} from '@/lib/mode';

/**
 * The mock/live switch.
 *
 * THE WHOLE MECHANISM IS THREE THINGS: a `localStorage` override,
 * this toggle, and a reload. There is no context, no per-call flag
 * and no dual provider, and that is the point -- `NEXT_PUBLIC_*` is
 * compiled into the bundle, so without an override changing mode
 * means a rebuild and, on Amplify, a redeploy. That is the wrong cost
 * for a decision someone makes mid-demo.
 *
 * THE RELOAD IS WHAT KEEPS THE REST SIMPLE. Without it, every cached
 * query, every context holding fetched rows and every module-level
 * memo would need to learn to invalidate itself, and the two modes
 * would have to be able to interleave. With it, a mode lasts exactly
 * one document lifetime and no code anywhere handles a change.
 *
 * It is per-browser, so flipping it affects the person flipping it
 * and nobody else -- which is what you want on a shared demo
 * deployment.
 */
export function DataSourceCard() {
  // Read after mount: `localStorage` does not exist during the server
  // render, so deciding this during the first render is how you get a
  // hydration mismatch.
  const [mock, setMock] = useState<boolean | null>(null);
  const [source, setSource] = useState<ModeSource>('build');
  const blockers = liveBlockedBy();
  const { toast } = useToast();

  useEffect(() => {
    setMock(isMock());
    setSource(modeSource());
  }, []);

  function apply(value: boolean | null): void {
    // A SWALLOWED WRITE MUST NOT LOOK LIKE A WORKING SWITCH. With
    // site data blocked the write silently does nothing, and
    // reloading would snap the toggle back with no explanation.
    if (!setMockOverride(value)) {
      toast({
        tone: 'warning',
        title: 'Could not change the data source',
        description: 'This browser is blocking site storage, so the choice cannot be saved.',
      });
      setMock(isMock());
      return;
    }
    window.location.reload();
  }

  const flip = (next: boolean): void => apply(next === BUILD_DEFAULT_IS_MOCK ? null : next);
  const clearOverride = (): void => apply(null);

  const live = mock === false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {live ? <Radio className="h-4 w-4 text-success" aria-hidden /> : <Database className="h-4 w-4" aria-hidden />}
          Data source
        </CardTitle>
        <CardDescription>
          Switch between the generated demo dataset and the live API. The page reloads, and the choice
          applies to this browser only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4 py-1">
          <label htmlFor="use-mock" className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium">Use mock data</span>
            <span className="block text-xs text-muted-foreground">
              {mock === null
                ? 'Checking…'
                : mock
                  ? 'Generated locally. No cloud API is contacted and nothing you do here leaves the browser.'
                  : 'Reading the live API. Figures are real and lag the provider by up to a day.'}
            </span>
          </label>
          <Switch
            id="use-mock"
            checked={mock ?? BUILD_DEFAULT_IS_MOCK}
            disabled={mock === null || (mock && blockers.length > 0)}
            onCheckedChange={flip}
          />
        </div>

        {blockers.length > 0 && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs">
            Live mode is unavailable in this build: {blockers.join(', ')} {blockers.length === 1 ? 'is' : 'are'} not
            set. A live mode that cannot reach anything is worse than the mock it replaced, so the
            switch is held.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {source === 'override'
            ? 'Set by this switch, overriding the build default.'
            : source === 'forced'
              ? 'Held on mock because live mode is unavailable in this build.'
              : BUILD_DEFAULT_IS_MOCK
              ? 'Using the build default, which is mock.'
              : 'Using the build default, which is live.'}
        </p>

        {/* 'forced' needs this button too, and that was the bug: a
            live override written while the build was healthy becomes
            unclearable the moment the build loses its env vars --
            the switch disables AND the reset disappears, leaving a
            stale override that silently reactivates live mode when
            the variables come back. */}
        {(source === 'override' || source === 'forced') && (
          <Button variant="outline" size="sm" onClick={clearOverride}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Follow the build default again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
