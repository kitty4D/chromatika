import { useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { RocketSeatGauge } from '@/ui/components/RocketSeatGauge';
import '@/ui/wallet-chrome-extras.css';

export function OnboardingCelebration({ onComplete }: { onComplete: () => void }) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const ms = reduceMotion ? 500 : 3200;
    const t = window.setTimeout(onComplete, ms);
    return () => window.clearTimeout(t);
  }, [onComplete, reduceMotion]);

  return (
    <motion.div
      className="ob-celebration"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reduceMotion ? 0.15 : 0.45, ease: [0.34, 1.2, 0.64, 1] }}
    >
      <p className="ob-celebration-kicker">vault secured</p>
      <h2 className="ob-celebration-title">liftoff</h2>
      <p className="ob-celebration-sub">your chromatika wallet is online. buckle up for dapps.</p>
      <motion.div
        className="ob-celebration-rocket"
        animate={
          reduceMotion
            ? undefined
            : {
                y: [0, -14, 0],
              }
        }
        transition={{
          duration: 2.4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        <RocketSeatGauge
          suiFillPct={100}
          ikaFillPct={100}
          suiHealth="green"
          ikaHealth="green"
          suiLabel="SUI · fueled"
          ikaLabel="IKA · ready"
          pilotHeadId="pilot-david"
          passengerHeadId="pilot-toly"
          animationsOn={!reduceMotion}
        />
      </motion.div>
    </motion.div>
  );
}
