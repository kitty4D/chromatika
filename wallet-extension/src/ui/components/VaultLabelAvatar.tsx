import { useState } from 'react';
import type { BaseChain } from '@/background/ika/ika-adapter';
import { ikaBaseChainLogoUrl } from '@/lib/ika-base-chain-logo';

export function VaultLabelAvatar({
  label,
  imageUrl,
  size = 28,
  ikaBaseChain,
}: {
  label: string;
  imageUrl?: string | null;
  /** css px */
  size?: number;
  /** when set, ika base chain logo sits behind the letter or image inside the circle */
  ikaBaseChain?: BaseChain;
}) {
  const [broken, setBroken] = useState(false);
  const initial = (label.trim()[0] ?? '?').toUpperCase();
  const chainUrl = ikaBaseChain ? ikaBaseChainLogoUrl(ikaBaseChain) : null;

  const chainRingClass = ikaBaseChain ? ` sp-vaultAvatar--ring-${ikaBaseChain}` : '';

  const imgNode =
    imageUrl && !broken ? (
      <img
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        className={`sp-vaultAvatar sp-vaultAvatar--img${chainRingClass}`}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    ) : (
      <span
        className={`sp-vaultAvatar sp-vaultAvatar--fallback${chainRingClass}`}
        style={{ width: size, height: size, fontSize: Math.max(11, size * 0.38) }}
        aria-hidden
      >
        {initial}
      </span>
    );

  if (chainUrl) {
    return (
      <span
        className={`sp-vaultAvatarWrap${chainRingClass}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <img src={chainUrl} alt="" className="sp-vaultAvatarChainBg" width={size} height={size} />
        {imgNode}
      </span>
    );
  }

  return imgNode;
}
