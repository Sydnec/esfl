'use client';

import Link from 'next/link';
import type { MatchSummary, TeamRef } from '@/lib/types';
import { Avatar } from './Avatar';
import styles from './StandingsTable.module.css';

interface Row {
  team: TeamRef;
  wins: number;
  losses: number;
}

/** Classement V/D calculé depuis les matchs finis d'une poule (round-robin). */
function computeStandings(matches: MatchSummary[]): Row[] {
  const rows = new Map<string, Row>();
  const ensure = (team: TeamRef | null) => {
    if (team && !rows.has(team.id)) rows.set(team.id, { team, wins: 0, losses: 0 });
  };
  for (const match of matches) {
    ensure(match.teamA);
    ensure(match.teamB);
    if (match.status !== 'finished' || !match.winnerTeamId) continue;
    const loserId = match.winnerTeamId === match.teamA?.id ? match.teamB?.id : match.teamA?.id;
    const winner = rows.get(match.winnerTeamId);
    const loser = loserId ? rows.get(loserId) : undefined;
    if (winner) winner.wins += 1;
    if (loser) loser.losses += 1;
  }
  return [...rows.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses);
}

export function StandingsTable({ matches }: { matches: MatchSummary[] }) {
  const rows = computeStandings(matches);
  if (rows.length === 0) return null;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.rank}>#</th>
          <th>Équipe</th>
          <th className={styles.num}>V</th>
          <th className={styles.num}>D</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.team.id}>
            <td className={styles.rank}>{i + 1}</td>
            <td>
              <Link className={styles.teamCell} href={`/teams/${row.team.id}`}>
                <Avatar src={row.team.imageUrl} label={row.team.name} size={20} />
                <span title={row.team.name}>{row.team.acronym || row.team.name}</span>
              </Link>
            </td>
            <td className={styles.num}>{row.wins}</td>
            <td className={styles.num}>{row.losses}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
