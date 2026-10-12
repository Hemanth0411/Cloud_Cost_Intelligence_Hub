'use client';

import { FlaskConical, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { SEVERITY_FIELDS, SPIKE_DROP_FIELDS, SUSTAINED_FIELDS, validateConfig } from '@/lib/anomaly-config-fields';
import {
  ANOMALY_PRESETS,
  DEFAULT_ANOMALY_CONFIG,
  matchPreset,
  PRESET_LABELS,
  type AnomalyPresetId,
} from '@/lib/selectors/detect-anomalies';
import { getAnomalies } from '@/lib/services/cost-service';
import type { AnomalyConfig } from '@/types/domain';
import { useDetectionConfig } from './detection-config-context';

type PresetChoice = AnomalyPresetId | 'custom';

const PRESET_OPTIONS: ReadonlyArray<SegmentedOption<PresetChoice>> = [
  { value: 'conservative', label: PRESET_LABELS.conservative, title: 'Fewer, higher-confidence alerts' },
  { value: 'balanced', label: PRESET_LABELS.balanced, title: 'Default thresholds' },
  { value: 'sensitive', label: PRESET_LABELS.sensitive, title: 'Catches smaller deviations' },
  { value: 'custom', label: 'Custom' },
];

interface NumberFieldProps {
  id: string;
  label: string;
  help?: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function NumberField({ id, label, help, unit, value, min, max, step, onChange }: NumberFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
      <div className="mt-1.5 flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
          className="h-9 w-28 rounded-md border border-input bg-card px-2.5 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function DetectionSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { config, setConfig, isDefault } = useDetectionConfig();
  const [draft, setDraft] = useState<AnomalyConfig>(config);
  const [preview, setPreview] = useState<{ draft: number; current: number } | null>(null);

  // Start from the active settings each time the dialog opens.
  useEffect(() => {
    if (open) {
      setDraft(config);
      setPreview(null);
    }
  }, [open, config]);

  const errors = validateConfig(draft);
  const preset = matchPreset(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  function patch(update: Partial<AnomalyConfig>): void {
    setDraft((prev) => ({ ...prev, ...update }));
    setPreview(null);
  }

  function patchSeverity(key: keyof AnomalyConfig['severity'], value: number): void {
    setDraft((prev) => ({ ...prev, severity: { ...prev.severity, [key]: value } }));
    setPreview(null);
  }

  function choosePreset(choice: PresetChoice): void {
    if (choice === 'custom') return;
    setDraft(ANOMALY_PRESETS[choice]);
    setPreview(null);
  }

  function runPreview(): void {
    if (errors.length > 0) return;
    setPreview({ draft: getAnomalies(draft).length, current: getAnomalies(config).length });
  }

  function apply(): void {
    if (errors.length > 0) return;
    setConfig(draft);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      className="sm:max-w-2xl"
      title="Detection settings"
      description="Thresholds for the rule-based engine. Changes re-run detection over the full history."
      footer={
        <>
          <Button variant="ghost" size="sm" className="mr-auto" onClick={() => { setDraft(DEFAULT_ANOMALY_CONFIG); setPreview(null); }} disabled={JSON.stringify(draft) === JSON.stringify(DEFAULT_ANOMALY_CONFIG) && isDefault}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restore defaults
          </Button>
          <Button variant="outline" size="sm" onClick={runPreview} disabled={errors.length > 0}>
            <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Preview results
          </Button>
          <Button size="sm" onClick={apply} disabled={errors.length > 0 || !dirty}>Apply</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <p className="text-sm font-medium">Sensitivity preset</p>
          <SegmentedControl ariaLabel="Sensitivity preset" options={PRESET_OPTIONS} value={preset} onChange={choosePreset} />
          <p className="text-xs text-muted-foreground">
            Four rules run on every account and service: <strong className="font-medium text-foreground">spike</strong>, <strong className="font-medium text-foreground">unexpected drop</strong>, <strong className="font-medium text-foreground">sustained increase</strong> and <strong className="font-medium text-foreground">sustained decrease</strong>. Each day is compared with comparable days (weekdays with weekdays, weekends with weekends).
          </p>
        </div>

        <Section title="Single-day spikes and drops">
          {SPIKE_DROP_FIELDS.map((f) => (
            <NumberField key={f.key} id={`cfg-${f.key}`} label={f.label} help={f.help} unit={f.unit} value={draft[f.key]} min={f.min} max={f.max} step={f.step} onChange={(v) => patch({ [f.key]: v })} />
          ))}
        </Section>

        <Section title="Sustained changes">
          {SUSTAINED_FIELDS.map((f) => (
            <NumberField key={f.key} id={`cfg-${f.key}`} label={f.label} help={f.help} unit={f.unit} value={draft[f.key]} min={f.min} max={f.max} step={f.step} onChange={(v) => patch({ [f.key]: v })} />
          ))}
        </Section>

        <Section title="Severity thresholds (either condition raises severity)">
          {SEVERITY_FIELDS.map((f) => (
            <NumberField key={f.key} id={`cfg-sev-${f.key}`} label={f.label} unit={f.unit} value={draft.severity[f.key]} min={f.min} max={f.max} step={f.step} onChange={(v) => patchSeverity(f.key, v)} />
          ))}
        </Section>

        {errors.length > 0 && (
          <ul role="alert" className="space-y-1 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            {errors.slice(0, 4).map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}

        {preview && (
          <p role="status" className="rounded-md bg-accent px-3 py-2.5 text-sm text-accent-foreground">
            These settings detect <strong>{preview.draft}</strong> anomalies across the full history, compared with <strong>{preview.current}</strong> with the current settings.
          </p>
        )}
      </div>
    </Dialog>
  );
}
