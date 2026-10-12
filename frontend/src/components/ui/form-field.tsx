import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

interface FormFieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}

/** Label + control + inline error/hint, wired for accessibility via the ids it documents. */
export function FormField({ id, label, error, hint, children }: FormFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

/** Attributes to spread on the control so screen readers announce the error/hint. */
export function fieldA11y(id: string, error?: string, hasHint = false): { 'aria-invalid': boolean; 'aria-describedby': string | undefined } {
  return { 'aria-invalid': error !== undefined, 'aria-describedby': error ? `${id}-error` : hasHint ? `${id}-hint` : undefined };
}
