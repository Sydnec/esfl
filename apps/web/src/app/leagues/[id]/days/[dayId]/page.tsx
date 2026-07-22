'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { Avatar } from '@/components/Avatar';
import { ApiError } from '@/lib/api';
import { sortTeamPlayers } from '@/lib/roles';
import type { BoardPlayer, PickBoard } from '@/lib/types';
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

  // Regroupement par équipe (tous jeux confondus, plus de sections par jeu) :
  // le jeu est indiqué à droite du nom d'équipe. Joueurs triés (ordre des rôles
  // LoL). Équipes ordonnées par jeu puis nom.
  const teamGroups = useMemo(() => {
    const byTeam = new Map<
      string,
      { team: BoardPlayer['team']; gameId: GameId; players: BoardPlayer[] }
    >();
    for (const player of filtered) {
      const key = player.team?.id ?? `sans-${player.gameId}`;
      const entry = byTeam.get(key) ?? { team: player.team, gameId: player.gameId, players: [] };
      entry.players.push(player);
      byTeam.set(key, entry);
    }
    const groups = [...byTeam.values()];
    for (const group of groups) group.players = sortTeamPlayers(group.players);
    return groups.sort(
      (a, b) =>
        a.gameId.localeCompare(b.gameId) || (a.team?.name ?? '').localeCompare(b.team?.name ?? ''),
    );
  }, [filtered]);

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
      <div className={styles.topLinks}>
        <Link href={`/leagues/${id}`} className={styles.back}>
          ← Retour à la ligue
        </Link>
        {board.myPicks.length > 0 && (
          <Link href={`/leagues/${id}/days/${dayId}/roster`} className={styles.back}>
            Voir mon roster →
          </Link>
        )}
      </div>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Journée du {board.matchDay.date}</h1>
        <span className={styles.deadline}>
          {board.matchDay.deadlinePassed
            ? 'Deadline passée : roster figé'
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

      {teamGroups.map(({ team, gameId, players: teamPlayers }) => {
        const selectedInTeam = teamPlayers.filter((p) => selected.has(p.id)).length;
        return (
          <details key={team?.id ?? `sans-${gameId}`} className={styles.teamGroup} open>
            <summary className={styles.teamTitle}>
              <span className={styles.teamName}>
                {team ? `${team.acronym ? `${team.acronym} · ` : ''}${team.name}` : 'Sans équipe'}
                {selectedInTeam > 0 && (
                  <span className={styles.teamCount}> · {selectedInTeam} sélectionné(s)</span>
                )}
              </span>
              <span className={styles.teamGame}>{GAME_LABELS[gameId]}</span>
            </summary>
            <ul className={styles.players}>
              {teamPlayers.map((player) => {
                const isSelected = selected.has(player.id);
                return (
                  <li key={player.id} className={styles.playerItem}>
                    <button
                      className={`${styles.player} ${isSelected ? styles.selected : ''} ${
                        player.locked ? styles.locked : ''
                      }`}
                      onClick={() => !player.locked && toggle(player.id)}
                      disabled={player.locked || board.matchDay.deadlinePassed}
                    >
                      <Avatar
                        src={player.imageUrl}
                        fallbackSrc={player.team?.imageUrl}
                        label={player.name}
                        size={30}
                        fit="cover"
                      />
                      <span className={styles.playerText}>
                        <span className={styles.playerName}>{player.name}</span>
                        <span className={styles.playerMeta}>{player.role ?? 'joueur'}</span>
                        {player.locked && (
                          <span className={styles.lockTag}>
                            verrouillé{player.lockedUntil ? ` → ${player.lockedUntil}` : ''}
                          </span>
                        )}
                      </span>
                    </button>
                    <Link className={styles.playerSheet} href={`/players/${player.id}`}>
                      fiche
                    </Link>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </main>
  );
}
