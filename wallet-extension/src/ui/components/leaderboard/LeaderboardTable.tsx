/**
 * sortable USD-ranked table of observed dWallets.
 */

import { LeaderboardRow } from '@/ui/components/leaderboard/LeaderboardRow';
import type { LeaderboardEntry } from '@/lib/use-leaderboard';

export function LeaderboardTable({
  rows,
  onRefreshRow,
}: {
  rows: LeaderboardEntry[];
  onRefreshRow: () => Promise<void> | void;
}) {
  return (
    <div
      role="table"
      aria-label="dWallet leaderboard"
      className="ch-leaderboardTable"
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <div
        role="row"
        className="sp-muted"
        style={{
          display: 'grid',
          gridTemplateColumns: '40px 1fr 80px 120px 40px',
          gap: 8,
          fontSize: 10,
          padding: '0 8px',
        }}
      >
        <span role="columnheader" style={{ textAlign: 'right' }}>#</span>
        <span role="columnheader">dWallet id · curve</span>
        <span role="columnheader" style={{ textAlign: 'right' }}>USD</span>
        <span role="columnheader" style={{ textAlign: 'right' }}>updated</span>
        <span role="columnheader" />
      </div>
      {rows.map((row, idx) => (
        <LeaderboardRow key={row.dwalletId} row={row} rank={idx + 1} onRefreshed={onRefreshRow} />
      ))}
    </div>
  );
}
