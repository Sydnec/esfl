'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { GAME_SHORT_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { Avatar } from '@/components/Avatar';
import { ApiError, request } from '@/lib/api';
import { formatDateTime, formatDayChip } from '@/lib/format';
import type { BoardPlayer, FantasyPointsLine, PickBoard } from '@/lib/types';
import styles from './page.module.css';

const POLL_INTERVAL_MS = 60_000;

export default function RosterViewPage() {
  const { id, dayId } = useParams<{ id: string; dayId: string }>();
  const { user, loading, authedFetch } = useAuth();
  const router = useRouter();

  const [board, setBoard] = useState<PickBoard | null>(null);
  const [points, setPoints] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const data = await authedFetch<PickBoard>(`/fantasy/leagues/${id}/matchdays/${dayId}/board`);
      setBoard(data);

      // Journée démarrée : points fantasy de mes joueurs sur les matchs du jour.
      if (data.matchDay.deadlinePassed && data.myPicks.length > 0) {
        const dayMatchIds = new Set(data.matches.map((match) => match.id));
        const lines = await request<FantasyPointsLine[]>(
          `/scoring/players?playerIds=${data.myPicks.join(',')}`,
        );
        const byPlayer = new Map<string, number>();
        for (const line of lines) {
          if (!dayMatchIds.has(line.matchId)) continue;
          byPlayer.set(line.playerId, (byPlayer.get(line.playerId) ?? 0) + line.points);
        }
        setPoints(byPlayer);
      } else {
        setPoints(new Map());
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Chargement impossible');
    }
  }, [id, dayId, authedFetch]);

  useEffect(() => {
    if (!user) return;
    void load();
    // Rafraîchissement des points tant que la journée est en cours.
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user, load]);

  // Mes joueurs (dans l'ordre du board), triés par points décroissants une fois
  // la journée démarrée.
  const roster = useMemo(() => {
    if (!board) return [];
    const byId = new Map(board.players.map((player) => [player.id, player]));
    const picked = board.myPicks
      .map((playerId) => byId.get(playerId))
      .filter((player): player is BoardPlayer => Boolean(player));
    if (!board.matchDay.deadlinePassed) return picked;
    return [...picked].sort((a, b) => (points.get(b.id) ?? -1) - (points.get(a.id) ?? -1));
  }, [board, points]);

  const total = useMemo(
    () => [...points.values()].reduce((sum, value) => sum + value, 0),
    [points],
  );

  if (loading || !user || !board) {
    return <main className={styles.main}>{error ?? 'Chargement…'}</main>;
  }

  const { matchDay, rosterSize } = board;
  const started = matchDay.deadlinePassed;

  return (
    <main className={styles.main}>
      <Link href={`/leagues/${id}`} className={styles.back}>
        ← Retour à la ligue
      </Link>

      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Mon roster</h1>
          <p className={styles.subtitle}>Journée du {formatDayChip(matchDay.date)}</p>
        </div>
        {started ? (
          <div className={styles.totalBadge}>
            <span className={styles.totalLabel}>Total</span>
            <span className={styles.totalValue}>{Math.round(total)} pts</span>
          </div>
        ) : (
          <Link href={`/leagues/${id}/days/${dayId}`} className={styles.editButton}>
            Modifier mon roster
          </Link>
        )}
      </header>

      <p className={styles.status}>
        {started
          ? 'Journée en cours ou terminée — roster figé.'
          : `Clôture des picks : ${formatDateTime(matchDay.firstMatchAt)}`}
      </p>
      {error && <p className={styles.error}>{error}</p>}

      {roster.length === 0 ? (
        <div className={styles.empty}>
          <p>Tu n’as pas encore composé de roster pour cette journée.</p>
          {!started && (
            <Link href={`/leagues/${id}/days/${dayId}`} className={styles.editButton}>
              Composer mon roster
            </Link>
          )}
        </div>
      ) : (
        <>
          <p className={styles.count}>
            {roster.length} / {rosterSize} joueurs
          </p>
          <ul className={styles.roster}>
            {roster.map((player) => {
              const pts = points.get(player.id);
              return (
                <li key={player.id} className={styles.card}>
                  <Avatar
                    src={player.imageUrl}
                    fallbackSrc={player.team?.imageUrl}
                    label={player.name}
                    size={44}
                    fit="cover"
                  />
                  <div className={styles.cardText}>
                    <Link href={`/players/${player.id}`} className={styles.name}>
                      {player.name}
                    </Link>
                    <span className={styles.meta}>
                      {GAME_SHORT_LABELS[player.gameId as GameId]}
                      {' · '}
                      {player.team?.acronym || player.team?.name || 'sans équipe'}
                      {player.role ? ` · ${player.role}` : ''}
                    </span>
                  </div>
                  {started && (
                    <span className={styles.points}>
                      {pts === undefined ? '—' : `${Math.round(pts)} pts`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
