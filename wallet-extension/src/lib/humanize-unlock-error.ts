/**
 * maps raw WebAuthn / platform strings into short unlock-screen copy (no spec links).
 */

export function humanizeUnlockError(source: string | null | undefined): string | null {
  if (source == null) return null;
  const raw = String(source).trim();
  if (!raw) return null;

  const stripped = raw
    .replace(/\s*See:\s*https?:\/\/[^\s)]+/gi, '')
    .replace(/\s*\(https?:\/\/[^)]*\)/gi, '')
    .trim();

  const lower = raw.toLowerCase();

  if (
    lower.includes('notallowederror')
    || lower.includes('the operation either timed out or was not allowed')
    || /timed out or was not allowed/.test(lower)
    || lower.includes('webauthn-2')
    || lower.includes('sctn-privacy')
  ) {
    return 'passkey was cancelled, timed out, or blocked. focus this window, try again, and allow the prompt when it appears.';
  }

  if (lower.includes('aborterror') || /\babort(ed)?\b/i.test(raw)) {
    return 'passkey or biometrics was cancelled. try again when you are ready.';
  }

  if (lower.includes('invalidstateerror')) {
    return 'this passkey is not available on this device or profile. use another unlock method if you have one.';
  }

  if (lower.includes('securityerror')) {
    return 'the browser blocked the passkey prompt. try again from the wallet window or check site settings.';
  }

  return stripped || raw;
}
