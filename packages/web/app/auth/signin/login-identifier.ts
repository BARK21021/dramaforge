const PHONE_REGEX = /^1[3-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidLoginIdentifier(value: string): boolean {
  const login = value.trim();
  return PHONE_REGEX.test(login) || EMAIL_REGEX.test(login);
}
