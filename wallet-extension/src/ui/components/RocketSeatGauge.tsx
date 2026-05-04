import { useMemo } from 'react';
import {
  RocketHeadDefs,
  pickPassengerHead,
  isRocketHeadId,
  DEFAULT_PILOT_HEAD,
  type RocketHeadId,
} from '@/ui/components/rocket-heads';
import { usePilotChoreography } from '@/ui/hooks/use-pilot-choreography';

export type VaultHealthVisual = 'green' | 'yellow' | 'red' | 'empty';

const SUI_LOGO = (
  <svg viewBox="0 0 783 1000" width="19" height="24" fill="none" aria-hidden>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M626.027 417.029C666.817 468.244 691.209 533.014 691.209 603.469C691.209 673.925 666.076 740.673 624.214 792.176L620.588 796.626L619.641 790.981C618.817 786.201 617.869 781.34 616.757 776.478C595.785 684.349 527.471 605.365 415.03 541.378C339.095 498.28 295.626 446.448 284.213 387.487C276.838 349.375 282.318 311.098 292.907 278.301C303.496 245.545 319.235 218.063 332.626 201.541L376.383 148.06C384.046 138.666 398.426 138.666 406.09 148.06L626.068 417.029H626.027ZM695.206 363.59L402.01 5.12968C396.407 -1.70989 385.942 -1.70989 380.338 5.12968L87.184 363.59L86.2363 364.784C32.3026 431.738 0 516.821 0 609.444C0 825.138 175.151 1000 391.174 1000C607.198 1000 782.349 825.138 782.349 609.444C782.349 516.821 750.046 431.738 696.112 364.826L695.165 363.631L695.206 363.59ZM157.351 415.876L183.556 383.779L184.339 389.712C184.957 394.409 185.74 399.106 186.646 403.844C203.622 492.883 264.23 567.088 365.546 624.565C453.637 674.708 504.934 732.35 519.684 795.554C525.864 821.924 526.936 847.881 524.258 870.584L524.093 871.985L522.816 872.603C483.055 892.009 438.351 902.927 391.133 902.927C225.459 902.927 91.1394 768.855 91.1394 603.428C91.1394 532.396 115.902 467.172 157.269 415.793L157.351 415.876Z"
      fill="currentColor"
    />
  </svg>
);

const SOL_LOGO = (
  <svg viewBox="0 0 397 312" width="22" height="18" fill="none" aria-hidden>
    <defs>
      <linearGradient id="cv-sol-grad" x1="360" y1="0" x2="36" y2="312" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#9945FF" />
        <stop offset="1" stopColor="#14F195" />
      </linearGradient>
    </defs>
    <path
      d="M64.6 237.9c2.4-2.4 5.7-3.7 9.2-3.7h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.7-9.2 3.7H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zm0-237.2C67.1-1.7 70.4-3 73.9-3h317.4c5.8 0 8.7 7 4.6 11.1L333.2 70.8c-2.4 2.4-5.7 3.7-9.2 3.7H6.5c-5.8 0-8.7-7-4.6-11.1L64.6.7zm268.6 121.4c-2.4-2.4-5.7-3.7-9.2-3.7H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.7 9.2 3.7h317.4c5.8 0 8.7-7 4.6-11.1l-62.6-62.7z"
      fill="url(#cv-sol-grad)"
    />
  </svg>
);

const IKA_LOGO = (
  <svg viewBox="0 0 97 79" width="28" height="23" fill="none" aria-hidden>
    <path d="M72.662 53.7167V29.3583C72.662 15.9056 61.7564 5 48.3036 5C34.8509 5 23.9453 15.9056 23.9453 29.3583V53.7167" stroke="currentColor" strokeWidth="9.61076"/>
    <path d="M72.663 45.5966V55.0693C72.663 60.3009 76.9041 64.542 82.1357 64.542C87.3673 64.542 91.6084 60.3009 91.6084 55.0693V45.5966" stroke="currentColor" strokeWidth="9.61076"/>
    <path d="M58.2969 78.2825V63.8479C58.2969 58.3288 53.8228 53.8547 48.3037 53.8547C42.7846 53.8547 38.3105 58.3288 38.3105 63.8479V78.2825" stroke="currentColor" strokeWidth="9.61076"/>
    <path d="M4.99994 45.5966V55.0693C4.99994 60.3009 9.24101 64.542 14.4726 64.542C19.7042 64.542 23.9453 60.3009 23.9453 55.0693V45.5966" stroke="currentColor" strokeWidth="9.61076"/>
    <path fillRule="evenodd" clipRule="evenodd" d="M48.3069 40.1827C52.7912 40.1827 56.4264 36.5475 56.4264 32.0633C56.4264 27.579 52.7912 23.9438 48.3069 23.9438C43.8227 23.9438 40.1875 27.579 40.1875 32.0633C40.1875 32.8954 40.3127 33.6982 40.5452 34.454C41.1817 33.0441 42.5999 32.0629 44.2472 32.0629C46.4893 32.0629 48.3069 33.8805 48.3069 36.1226C48.3069 37.7701 47.3256 39.1884 45.9155 39.8248C46.6715 40.0575 47.4746 40.1827 48.3069 40.1827Z" fill="currentColor"/>
  </svg>
);

export function RocketSeatGauge({
  suiFillPct,
  ikaFillPct,
  suiHealth,
  ikaHealth,
  suiLabel,
  ikaLabel,
  pilotHeadId,
  passengerHeadId,
  animationsOn,
  funded = true,
  baseChain = 'sui',
}: {
  suiFillPct: number;
  ikaFillPct: number;
  suiHealth: Exclude<VaultHealthVisual, 'empty'>;
  ikaHealth: Exclude<VaultHealthVisual, 'empty'>;
  suiLabel: string;
  ikaLabel: string;
  pilotHeadId: string;
  passengerHeadId?: RocketHeadId;
  animationsOn: boolean;
  /** false: empty fuel gauges, cockpit motion off; crew still shows (settings) */
  funded?: boolean;
  /** which chain logo to render in the left (gas) gauge. defaults to sui. */
  baseChain?: 'sui' | 'solana';
}) {
  const pilot: RocketHeadId = isRocketHeadId(pilotHeadId) ? pilotHeadId : DEFAULT_PILOT_HEAD;
  const passenger = useMemo(
    () => passengerHeadId ?? pickPassengerHead(new Date(), pilot),
    [passengerHeadId, pilot],
  );

  const { driver: d, passenger: p } = usePilotChoreography(
    pilot,
    passenger,
    animationsOn && funded,
  );

  const worstHealth: VaultHealthVisual = !funded
    ? 'red'
    : suiHealth === 'red' || ikaHealth === 'red'
      ? 'red'
      : suiHealth === 'yellow' || ikaHealth === 'yellow'
        ? 'yellow'
        : 'green';

  const gaugeHealth = (h: Exclude<VaultHealthVisual, 'empty'>) => (funded ? h : 'empty');

  const suiW = funded ? Math.max(6, suiFillPct) : suiFillPct;
  const ikaW = funded ? Math.max(6, ikaFillPct) : ikaFillPct;
  const suiScale = Math.min(1, Math.max(0, suiW / 100));
  const ikaScale = Math.min(1, Math.max(0, ikaW / 100));

  return (
    <div
      className="cv-rocket"
      data-vault-health={funded ? worstHealth : 'unfunded'}
      data-funded={funded ? 'true' : 'false'}
      data-animations={animationsOn && funded ? 'on' : 'off'}
    >
      {/* fuel gauges - HTML above the SVG cockpit */}
      <div className="cv-gaugeRow">
        <div className="cv-gauge cv-gauge--sui" data-health={gaugeHealth(suiHealth)}>
          <div className="cv-gauge-track">
            <div
              className="cv-gauge-fill"
              style={{ ['--cv-gauge-fill-scale' as string]: String(suiScale) }}
            />
            <span className="cv-gauge-label">
              {baseChain === 'solana' ? SOL_LOGO : SUI_LOGO}
              {suiLabel}
            </span>
          </div>
        </div>
        <div className="cv-gauge cv-gauge--ika" data-health={gaugeHealth(ikaHealth)}>
          <div className="cv-gauge-track">
            <div
              className="cv-gauge-fill"
              style={{ ['--cv-gauge-fill-scale' as string]: String(ikaScale) }}
            />
            <span className="cv-gauge-label">
              {IKA_LOGO}
              {ikaLabel}
            </span>
          </div>
        </div>
      </div>

      {/* cockpit SVG - animates and dips behind the card below */}
      <div className="cv-cockpitWrap">
        <svg className="cv-rocket-svg" viewBox="0 0 320 140" aria-hidden>
          <RocketHeadDefs />

          {/* layer 1: cockpit dashboard (background) */}
          <image
            href="/pilots/blockpit.png"
            x="0" y="0" width="320" height="140"
            preserveAspectRatio="xMidYMid meet"
            className="cv-cockpitImage"
            opacity="0.63"
          />

          {/* layer 2: heads — always show picks from settings; motion ties to funded (see usePilotChoreography) */}
          <g transform="translate(43, 19) scale(1.15)">
            <g className="cv-pilotGroup">
              <g
                style={{
                  opacity: d.opacity,
                  transform: `translate(${d.offsetX}px, ${d.offsetY}px)`,
                }}
              >
                <use href={`#${d.symbolId}`} width="86" height="86" className="cv-headUse" />
              </g>
            </g>
          </g>
          <g transform="translate(180, 25) scale(1.16)">
            <g className="cv-passengerGroup">
              {p.flipX ? (
                <g transform="translate(87, 0) scale(-1, 1)">
                  <g
                    style={{
                      opacity: p.opacity,
                      transform: `translate(${p.offsetX}px, ${p.offsetY}px)`,
                    }}
                  >
                    <use
                      href={`#${p.symbolId}`}
                      width="87"
                      height="87"
                      className="cv-headUse cv-headUse--passenger"
                    />
                  </g>
                </g>
              ) : (
                <g
                  style={{
                    opacity: p.opacity,
                    transform: `translate(${p.offsetX}px, ${p.offsetY}px)`,
                  }}
                >
                  <use
                    href={`#${p.symbolId}`}
                    width="87"
                    height="87"
                    className="cv-headUse cv-headUse--passenger"
                  />
                </g>
              )}
            </g>
          </g>

          {/* layer 3: seats (closest to viewer) */}
          <image
            href="/pilots/seat.png"
            x="32" y="50" width="120" height="120"
            preserveAspectRatio="xMidYMid meet"
            className="cv-seatImage"
          />
          <image
            href="/pilots/seat.png"
            x="169" y="50" width="120" height="120"
            preserveAspectRatio="xMidYMid meet"
            className="cv-seatImage"
          />

        </svg>
      </div>
    </div>
  );
}
