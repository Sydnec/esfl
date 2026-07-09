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
function TeamSide({ team, side }: { team: TeamRef | null; side: 'A' | 'B' }) {
  if (!team) {
    return <span className={styles.tbd}>TBD</span>;
  }
  return (
    <span
      className={`${styles.team} ${side === 'B' ? styles.reverse : ''}`}
      title={team.name}
    >
      <Avatar src={team.imageUrl} label={team.name} size={20} />
      <span className={styles.tag}>{teamTag(team)}</span>
    </span>
  );
}

export function MatchCard({ match }: { match: MatchSummary }) {
  const running = match.status === 'running';
  const withScore = running || match.status === 'finished';
  return (
    <li>
      <Link href={`/matches/${match.id}`} className={styles.card}>
        <span className={styles.meta}>
          {running ? (
            <span><span className={styles.live}>●</span> {formatKickoff(match.scheduledAt)}<span style={{ opacity: 0 }}>●</span></span>
          ) : match.status === 'finished' ? (
            'Terminé'
          ) : (
            formatKickoff(match.scheduledAt)
          )}
        </span>
        <span className={styles.row}>
          <TeamSide team={match.teamA} side="A" />
          <span className={styles.center}>
            {withScore ? (
              <>
                <strong className={styles.score}>{match.scoreA ?? 0}</strong>
                <span className={styles.vs}>vs</span>
                <strong className={styles.score}>{match.scoreB ?? 0}</strong>
              </>
            ) : (
              <span className={styles.vs}>vs</span>
            )}
          </span>
          <TeamSide team={match.teamB} side="B" />
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
