'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { ApiError } from '@/lib/api';
import type { PickBoard } from '@/lib/types';
import styles from './page.module.css';

export default function PickPage() {
  const { id, dayId } = useParams<{ id: string; dayId: string }>();
  const { user, loading, authedFetch } = useAuth();
  const router = useRouter();

  const [board, setBoard] = useState<PickBoard | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const data = await authedFetch<PickBoard>(`/fantasy/leagues/${id}/matchdays/${dayId}/board`);
      setBoard(data);
      setSelected(new Set(data.myPicks));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Chargement impossible');
    }
  }, [id, dayId, authedFetch]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const filtered = useMemo(() => {
    if (!board) return [];
    const term = search.trim().toLowerCase();
    return term
      ? board.players.filter(
          (player) =>
            player.name.toLowerCase().includes(term) ||
            (player.team?.name.toLowerCase().includes(term) ?? false),
        )
      : board.players;
  }, [board, search]);

  function toggle(playerId: string) {
    if (!board || board.matchDay.deadlinePassed) return;
    setSaved(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else if (next.size < board.rosterSize) {
        next.add(playerId);
      }
      return next;
    });
  }

  async function handleSubmit() {
    if (!board || selected.size === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      await authedFetch(`/fantasy/leagues/${id}/matchdays/${dayId}/roster`, {
        method: 'PUT',
        body: JSON.stringify({ playerIds: [...selected] }),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Soumission impossible');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !user || !board) {
    return <main className={styles.main}>{error ?? 'Chargement…'}</main>;
  }

  const deadline = new Date(board.matchDay.firstMatchAt);

  return (
    <main className={styles.main}>
      <Link href={`/leagues/${id}`} className={styles.back}>
        ← Retour à la ligue
      </Link>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Journée du {board.matchDay.date}</h1>
        <span className={styles.deadline}>
          {board.matchDay.deadlinePassed
            ? 'Deadline passée — roster figé'
            : `Deadline : ${deadline.toLocaleString('fr-FR', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}`}
        </span>
      </div>

      <div className={styles.bar}>
        <span className={styles.counter}>
          {selected.size} / {board.rosterSize} joueurs sélectionnés
        </span>
        <input
          className={styles.search}
          placeholder="Rechercher un joueur ou une équipe…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {!board.matchDay.deadlinePassed && (
          <button
            className={styles.submit}
            onClick={() => void handleSubmit()}
            disabled={submitting || selected.size === 0}
          >
            Valider mon roster
          </button>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {saved && <p className={styles.saved}>Roster enregistré ✓</p>}

      {GAME_IDS.map((gameId: GameId) => {
        const players = filtered.filter((player) => player.gameId === gameId);
        if (players.length === 0) return null;
        // Regroupement par équipe : seuls les joueurs dont l'équipe dispute
        // un match ce jour-là sont listés par le backend.
        const byTeam = new Map<string, typeof players>();
        for (const player of players) {
          const key = player.team?.id ?? 'sans-equipe';
          byTeam.set(key, [...(byTeam.get(key) ?? []), player]);
        }
        const teams = [...byTeam.values()].sort((a, b) =>
          (a[0].team?.name ?? '').localeCompare(b[0].team?.name ?? ''),
        );
        return (
          <section key={gameId} className={styles.gameSection}>
            <h2 className={styles.gameTitle}>{GAME_LABELS[gameId]}</h2>
            {teams.map((teamPlayers) => (
              <div key={teamPlayers[0].team?.id ?? 'sans-equipe'} className={styles.teamGroup}>
                <h3 className={styles.teamTitle}>
                  {teamPlayers[0].team
                    ? `${teamPlayers[0].team.acronym ? `${teamPlayers[0].team.acronym} — ` : ''}${teamPlayers[0].team.name}`
                    : 'Sans équipe'}
                </h3>
                <ul className={styles.players}>
                  {teamPlayers.map((player) => {
                    const isSelected = selected.has(player.id);
                    return (
                      <li key={player.id}>
                        <button
                          className={`${styles.player} ${isSelected ? styles.selected : ''} ${
                            player.locked ? styles.locked : ''
                          }`}
                          onClick={() => !player.locked && toggle(player.id)}
                          disabled={player.locked || board.matchDay.deadlinePassed}
                        >
                          <span className={styles.playerName}>{player.name}</span>
                          <span className={styles.playerMeta}>
                            {player.role ?? 'joueur'}
                          </span>
                          {player.locked && (
                            <span className={styles.lockTag}>
                              verrouillé{player.lockedUntil ? ` → ${player.lockedUntil}` : ''}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </main>
  );
}
