'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GAME_LABELS } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { request } from '@/lib/api';
import { pointsDefinitifs } from '@/lib/format';
import { flagEmoji } from '@/lib/flags';
import { formatStat, STAT_COLUMNS } from '@/lib/stat-columns';
import type { FantasyPointsLine, PlayerMatchHistoryLine, PlayerRef } from '@/lib/types';
import styles from './page.module.css';

/** Date courte d'un match : « 08/07 ». */
function formatMatchDate(iso: string | null): string {
  if (!iso) return '·';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/** Points fantasy : des entiers depuis le scoring v1, affichés tels quels. */
function formatPoints(value: number | undefined): string {
  return value === undefined ? '·' : String(Math.round(value));
}

/** Moyenne de notes entières : une décimale suffit à départager. */
function formatMoyenne(value: number | null | undefined): string {
  return value == null ? '·' : value.toFixed(1);
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
        // Un match en cours porte une note provisoire : hors historique et
        // hors moyenne tant qu'il n'est pas terminé.
        const termines = new Set(
          lines.filter((line) => pointsDefinitifs(line.match.status)).map((line) => line.matchId),
        );
        setPoints(
          new Map(
            fantasyPoints
              .filter((line) => termines.has(line.matchId))
              .map((line) => [line.matchId, line.points]),
          ),
        );
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

  // Historique : colonnes essentielles seulement (le détail avancé vit sur la page match).
  const columns = STAT_COLUMNS[player.gameId].base;
  const ratedPoints = history
    .map((line) => points.get(line.matchId))
    .filter((value): value is number => value !== undefined);
  const totalPoints = Math.round(ratedPoints.reduce((sum, value) => sum + value, 0) * 100) / 100;
  const average =
    ratedPoints.length > 0 ? Math.round((totalPoints / ratedPoints.length) * 100) / 100 : null;

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
            <Link className={styles.team} href={`/teams/${player.team.id}`}>
              <Avatar src={player.team.imageUrl} label={player.team.name} size={20} />
              {player.team.name} {flagEmoji(player.team.location)}
            </Link>
          )}
        </div>
      </header>

      {ratedPoints.length > 0 && (
        <dl className={styles.summary}>
          <div className={styles.summaryItem}>
            <dt>Points fantasy</dt>
            <dd>{formatPoints(totalPoints)}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Moyenne / match</dt>
            <dd>{formatMoyenne(average)}</dd>
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
                  <th>Match</th>
                  {columns.map((column) => (
                    <th key={column.key} title={column.title}>
                      {column.label}
                    </th>
                  ))}
                  <th className={styles.pts}>Pts fantasy</th>
                </tr>
              </thead>
              <tbody>
                {history.map((line) => {
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
                        <span className={styles.matchCell}>
                          <span
                            className={styles.matchTeam}
                            title={match.teamA?.name ?? 'À déterminer'}
                          >
                            <Avatar
                              src={match.teamA?.imageUrl}
                              label={match.teamA?.name ?? 'TBD'}
                              size={20}
                            />
                          </span>
                          <span className={styles.matchScore}>
                            <span
                              className={
                                match.winnerTeamId != null && match.winnerTeamId === match.teamA?.id
                                  ? styles.win
                                  : undefined
                              }
                            >
                              {match.scoreA ?? '·'}
                            </span>
                            <span className={styles.dash}>-</span>
                            <span
                              className={
                                match.winnerTeamId != null && match.winnerTeamId === match.teamB?.id
                                  ? styles.win
                                  : undefined
                              }
                            >
                              {match.scoreB ?? '·'}
                            </span>
                          </span>
                          <span
                            className={styles.matchTeam}
                            title={match.teamB?.name ?? 'À déterminer'}
                          >
                            <Avatar
                              src={match.teamB?.imageUrl}
                              label={match.teamB?.name ?? 'TBD'}
                              size={20}
                            />
                          </span>
                        </span>
                      </td>
                      {columns.map((column) => (
                        <td key={column.key}>
                          {formatStat(line.normalized[column.key], column.pct)}
                        </td>
                      ))}
                      <td className={styles.pts}>{formatPoints(points.get(line.matchId))}</td>
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
