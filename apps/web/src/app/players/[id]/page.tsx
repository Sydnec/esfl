'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GAME_LABELS } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { request } from '@/lib/api';
import { flagEmoji } from '@/lib/flags';
import { formatStat, STAT_COLUMNS } from '@/lib/stat-columns';
import type { FantasyPointsLine, PlayerMatchHistoryLine, PlayerRef } from '@/lib/types';
import styles from './page.module.css';

/** Date courte d'un match : « 08/07 ». */
function formatMatchDate(iso: string | null): string {
  if (!iso) return '·';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const [history, setHistory] = useState<PlayerMatchHistoryLine[]>([]);
  const [points, setPoints] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [detail, lines, fantasyPoints] = await Promise.all([
          request<PlayerRef>(`/data/players/${id}`),
          request<PlayerMatchHistoryLine[]>(`/data/players/${id}/matches`),
          request<FantasyPointsLine[]>(`/scoring/players?playerIds=${id}`),
        ]);
        if (cancelled) return;
        setPlayer(detail);
        setHistory(lines);
        setPoints(new Map(fantasyPoints.map((line) => [line.matchId, line.points])));
      } catch {
        if (!cancelled) setError('Joueur introuvable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <main className={styles.main}>{error}</main>;
  if (!player) return <main className={styles.main}>Chargement…</main>;

  const columns = STAT_COLUMNS[player.gameId];
  const ratedPoints = history
    .map((line) => points.get(line.matchId))
    .filter((value): value is number => value !== undefined);
  const totalPoints = Math.round(ratedPoints.reduce((sum, value) => sum + value, 0) * 100) / 100;
  const average =
    ratedPoints.length > 0 ? Math.round((totalPoints / ratedPoints.length) * 100) / 100 : null;

  /** Adversaire du joueur sur un match (l'équipe qui n'est pas la sienne). */
  const opponentOf = (line: PlayerMatchHistoryLine) => {
    const { teamA, teamB } = line.match;
    if (player.team && teamA?.id === player.team.id) return teamB;
    return teamA;
  };

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Avatar
          src={player.imageUrl}
          fallbackSrc={player.team?.imageUrl}
          label={player.name}
          size={64}
          fit="cover"
        />
        <div className={styles.identity}>
          <h1 className={styles.name}>
            {player.name} {flagEmoji(player.nationality)}
          </h1>
          <p className={styles.meta}>
            {GAME_LABELS[player.gameId]}
            {player.role ? ` · ${player.role}` : ''}
          </p>
          {player.team && (
            <p className={styles.team}>
              <Avatar src={player.team.imageUrl} label={player.team.name} size={20} />
              {player.team.name} {flagEmoji(player.team.location)}
            </p>
          )}
        </div>
      </header>

      {ratedPoints.length > 0 && (
        <dl className={styles.summary}>
          <div className={styles.summaryItem}>
            <dt>Points fantasy</dt>
            <dd>{totalPoints}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Moyenne / match</dt>
            <dd>{average}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Matchs notés</dt>
            <dd>{ratedPoints.length}</dd>
          </div>
        </dl>
      )}

      {history.length === 0 ? (
        <p className={styles.empty}>Aucun match noté pour l’instant.</p>
      ) : (
        <section className={styles.historySection}>
          <h2 className={styles.historyTitle}>Derniers matchs</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Compétition</th>
                  <th>Adversaire</th>
                  <th>Score</th>
                  {columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                  <th>Pts fantasy</th>
                </tr>
              </thead>
              <tbody>
                {history.map((line) => {
                  const opponent = opponentOf(line);
                  const { match } = line;
                  return (
                    <tr key={line.id}>
                      <td>
                        <Link className={styles.matchLink} href={`/matches/${match.id}`}>
                          {formatMatchDate(match.scheduledAt)}
                        </Link>
                      </td>
                      <td className={styles.competitionCell}>{match.competition.name}</td>
                      <td>
                        <span className={styles.opponentCell}>
                          {opponent && (
                            <Avatar src={opponent.imageUrl} label={opponent.name} size={20} />
                          )}
                          {opponent?.acronym || opponent?.name || 'TBD'}
                        </span>
                      </td>
                      <td className={styles.score}>
                        {match.scoreA != null && match.scoreB != null
                          ? `${match.scoreA}-${match.scoreB}`
                          : '·'}
                      </td>
                      {columns.map((column) => (
                        <td key={column.key}>{formatStat(line.normalized[column.key])}</td>
                      ))}
                      <td className={styles.points}>{points.get(line.matchId) ?? '·'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
