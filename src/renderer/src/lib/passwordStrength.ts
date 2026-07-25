export type PasswordStrength = 'empty' | 'weak' | 'medium' | 'strong';

export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) return 'empty';
  if (password.length < 8) return 'weak';

  const varietyCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;

  if (password.length >= 10 && varietyCount >= 3) return 'strong';
  if (password.length >= 8 && varietyCount >= 2) return 'medium';
  return 'weak';
}
