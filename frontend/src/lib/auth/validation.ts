/** Pure form validation (no dependencies), shared by the auth forms and the tests. */

export const PASSWORD_MIN_LENGTH = 8;

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export function validateEmail(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'Email is required';
  if (v.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Enter a valid email address';
  return null;
}

export function validateName(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'Name is required';
  if (v.length < 2) return 'Name must be at least 2 characters';
  if (v.length > 60) return 'Name must be 60 characters or fewer';
  return null;
}

export function validatePassword(value: string): string | null {
  if (value === '') return 'Password is required';
  if (value.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Include at least one letter and one number';
  if (value.length > 128) return 'Password must be 128 characters or fewer';
  return null;
}

export function validateConfirm(password: string, confirm: string): string | null {
  if (confirm === '') return 'Confirm your password';
  return password === confirm ? null : 'Passwords do not match';
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'Too short' | 'Weak' | 'Fair' | 'Good' | 'Strong';
}

/** A simple, explainable meter: length, mixed case, digits, symbols. Not a security guarantee. */
export function passwordStrength(value: string): PasswordStrength {
  if (value.length < PASSWORD_MIN_LENGTH) return { score: 0, label: 'Too short' };
  let points = 0;
  if (value.length >= 12) points += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) points += 1;
  if (/\d/.test(value)) points += 1;
  if (/[^A-Za-z0-9]/.test(value)) points += 1;
  const score = Math.max(1, Math.min(4, points)) as 1 | 2 | 3 | 4;
  return { score, label: (['Weak', 'Fair', 'Good', 'Strong'] as const)[score - 1] ?? 'Weak' };
}

const compact = <K extends string>(errors: FieldErrors<K>): FieldErrors<K> =>
  Object.fromEntries(Object.entries(errors).filter(([, v]) => v !== null && v !== undefined)) as FieldErrors<K>;

export function validateLogin(input: { email: string; password: string }): FieldErrors<'email' | 'password'> {
  return compact({
    email: validateEmail(input.email) ?? undefined,
    password: input.password === '' ? 'Password is required' : undefined,
  });
}

export function validateRegistration(input: {
  name: string;
  email: string;
  password: string;
  confirm: string;
  acceptedDemoTerms: boolean;
}): FieldErrors<'name' | 'email' | 'password' | 'confirm' | 'terms'> {
  return compact({
    name: validateName(input.name) ?? undefined,
    email: validateEmail(input.email) ?? undefined,
    password: validatePassword(input.password) ?? undefined,
    confirm: validateConfirm(input.password, input.confirm) ?? undefined,
    terms: input.acceptedDemoTerms ? undefined : 'Please confirm you understand this is a demo',
  });
}

export function validateReset(input: { password: string; confirm: string }): FieldErrors<'password' | 'confirm'> {
  return compact({
    password: validatePassword(input.password) ?? undefined,
    confirm: validateConfirm(input.password, input.confirm) ?? undefined,
  });
}

/** "sam.lee@example.com" -> "s*****@example.com" (used so a reset page never shows the full address). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return email;
  return `${email[0] ?? ''}${'*'.repeat(Math.min(5, Math.max(2, at - 1)))}${email.slice(at)}`;
}
