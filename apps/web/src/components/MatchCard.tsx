'use client';

import Link from 'next/link';
import { formatKickoff } from '@/lib/format';
import type { MatchSummary, TeamRef } from '@/lib/types';
import { Avatar } from './Avatar';
import styles from './MatchCard.module.css';

function teamTag(team: TeamRef | null): string {
  return team?.acronym || team?.name || 'TBD';
}

/** Côté d'équipe, miroir : logo côté extérieur, tag côté score. */
function TeamSide({ team, side, won }: { team: TeamRef | null; side: 'A' | 'B'; won?: boolean }) {
  if (!team) {
    return <span className={styles.tbd}>TBD</span>;
  }
  return (
    <span
      className={`${styles.team} ${side === 'B' ? styles.reverse : ''} ${won ? styles.won : ''}`}
      title={team.name}
    >
      <Avatar src={team.imageUrl} label={team.name} size={20} />
      <span className={styles.tag}>{teamTag(team)}</span>
    </span>
  );
}

export function MatchCard({ match }: { match: MatchSummary }) {
  const running = match.status === 'running';
  const forfeit = match.forfeit ?? match.status === 'canceled';
  const withScore = running || match.status === 'finished';
  const winnerSide =
    match.winnerTeamId === match.teamA?.id
      ? 'A'
      : match.winnerTeamId === match.teamB?.id
        ? 'B'
        : null;
  return (
    <li>
      <Link href={`/matches/${match.id}`} className={styles.card}>
        <span className={styles.meta}>
          {running ? (
            <span>
              <span className={styles.live}>●</span> {formatKickoff(match.scheduledAt)}
              <span style={{ opacity: 0 }}>●</span>
            </span>
          ) : match.status === 'finished' ? (
            'Terminé'
          ) : forfeit ? (
            'Forfait'
          ) : (
            formatKickoff(match.scheduledAt)
          )}
        </span>
        <span className={styles.row}>
          <TeamSide team={match.teamA} side="A" won={forfeit && winnerSide === 'A'} />
          <span className={styles.center}>
            {withScore ? (
              <>
                <strong className={styles.score}>{match.scoreA ?? 0}</strong>
                <span className={styles.vs}>vs</span>
                <strong className={styles.score}>{match.scoreB ?? 0}</strong>
              </>
            ) : forfeit ? (
              <span className={styles.vs}>W.O.</span>
            ) : (
              <span className={styles.vs}>vs</span>
            )}
          </span>
          <TeamSide team={match.teamB} side="B" won={forfeit && winnerSide === 'B'} />
        </span>
      </Link>
    </li>
  );
}

/** Grille de cartes : plusieurs matchs par ligne. */
export function MatchGrid({ matches }: { matches: MatchSummary[] }) {
  return (
    <ul className={styles.grid}>
      {matches.map((match) => (
        <MatchCard key={match.id} match={match} />
      ))}
    </ul>
  );
}
