'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { passwordStrength } from '@/lib/auth/validation';
import { cn } from '@/lib/utils';

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  autoComplete: 'current-password' | 'new-password';
  showStrength?: boolean;
  hint?: string;
}

const BAR_COLOR = ['bg-destructive', 'bg-destructive', 'bg-warning', 'bg-success', 'bg-success'] as const;

export function PasswordField({ id, label, value, onChange, error, autoComplete, showStrength, hint }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(value);

  return (
    <FormField id={id} label={label} error={error} hint={hint}>
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
          {...fieldA11y(id, error, Boolean(hint))}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {showStrength && value !== '' && (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex gap-1" aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={cn('h-1.5 flex-1 rounded-full bg-muted transition-colors', strength.score >= i && BAR_COLOR[strength.score])} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Strength: <span className="font-medium text-foreground">{strength.label}</span></p>
        </div>
      )}
    </FormField>
  );
}
