/**
 * Normalises Nigerian numbers to E.164 before they are ever stored or compared.
 *
 * People type the same number five ways — 0803..., 234803..., +234 803...,
 * with spaces or dashes. Normalising at the edge means `users.phone` can carry
 * a unique index that actually means "one account per human".
 */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");

  if (/^\+234[789]\d{9}$/.test(digits)) return digits;
  if (/^234[789]\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0[789]\d{9}$/.test(digits)) return `+234${digits.slice(1)}`;
  // Other countries: accept any plausible E.164 so testers abroad can sign in.
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;

  return null;
}
