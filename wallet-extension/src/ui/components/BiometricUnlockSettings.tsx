import { useEffect, useState } from 'react';
import {
  biometricUnlockSupported,
  clearBiometricUnlockEnrollment,
  enrollBiometricUnlock,
  hasBiometricUnlockEnrollment,
} from '@/lib/biometric-unlock';

/**
 * settings: enroll or clear WebAuthn passkey unlock (largeBlob-sealed app password).
 * pre-alpha: depends on Chrome passkey + largeBlob; may not work on all extension surfaces.
 */
export function BiometricUnlockSettings() {
  const [supported, setSupported] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setSupported(biometricUnlockSupported());
    void hasBiometricUnlockEnrollment().then(setEnrolled);
  }, []);

  async function onEnroll() {
    setMsg(null);
    if (password.length < 8) {
      setMsg('enter your chromatika password (8+ chars) to enroll');
      return;
    }
    setBusy(true);
    try {
      await enrollBiometricUnlock(password);
      setPassword('');
      setEnrolled(true);
      setMsg('biometric unlock enabled for this device.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    setMsg(null);
    setBusy(true);
    try {
      await clearBiometricUnlockEnrollment();
      setEnrolled(false);
      setMsg('biometric unlock removed. passkey may still exist in the OS — remove it from system settings if you want it gone.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!supported) {
    return (
      <div className="sp-section">
        <div className="sp-sectionTitle">unlock with biometrics</div>
        <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
          WebAuthn passkeys are not available in this context. Use the normal password unlock.
        </p>
      </div>
    );
  }

  return (
    <div className="sp-section">
      <div className="sp-sectionTitle">unlock with biometrics</div>
      <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.45, marginBottom: 10 }}>
        stores your chromatika password sealed on a passkey (platform biometrics). only this extension can request unlock.
        requires a browser that supports passkey <strong>largeBlob</strong> (recent Chrome). dev-only stack — review{' '}
        <code style={{ fontSize: 11 }}>WALLET_SECURITY.md</code> before trusting for real funds.
      </p>
      {enrolled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="sp-muted" style={{ fontSize: 12, margin: 0 }}>
            biometric unlock is <strong>on</strong> for this profile.
          </p>
          <button type="button" className="sp-btn" disabled={busy} onClick={() => void onClear()}>
            {busy ? 'working…' : 'turn off biometric unlock'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="password"
            className="sp-input"
            autoComplete="current-password"
            placeholder="chromatika password (to seal)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="sp-btn sp-btnPrimary" disabled={busy} onClick={() => void onEnroll()}>
            {busy ? 'working…' : 'set up biometric unlock'}
          </button>
        </div>
      )}
      {msg && (
        <p className="sp-muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.45 }}>
          {msg}
        </p>
      )}
    </div>
  );
}
