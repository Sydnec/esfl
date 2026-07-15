'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { formatDateTime } from '@/lib/format';
import styles from './page.module.css';

interface GameAvg {
  gameId: GameId;
  avgPoints: number;
  scores: number;
}

interface RoleAvg {
  role: string;
  avgPoints: number;
  scores: number;
  players: number;
}

interface TopPlayer {
  playerId: string;
  name: string;
  gameId: GameId;
  role: string | null;
  team: string | null;
  avgPoints: number;
  scores: number;
}

interface PointStats {
  generatedAt: string;
  minScores: number;
  byGame: GameAvg[];
  byRole: RoleAvg[];
  topPlayers: TopPlayer[];
}

function gameLabel(gameId: string): string {
  return GAME_LABELS[gameId as GameId] ?? gameId;
}

/** Barre horizontale proportionnelle (max = 100 %). */
function Bar({ value, max, label, sub }: { value: number; max: number; label: string; sub?: string }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className={styles.barRow}>
      <span className={styles.barLabel}>{label}</span>
      <span className={styles.barTrack}>
        <span className={styles.barFill} style={{ width: `${width}%` }} />
      </span>
      <span className={styles.barValue}>
        {value.toFixed(2)}
        {sub && <span className={styles.barSub}> · {sub}</span>}
      </span>
    </div>
  );
}

export default function AdminStatsPage() {
  const { user, loading, authedFetch } = useAuth();
  const [stats, setStats] = useState<PointStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gameFilter, setGameFilter] = useState<GameId | 'all'>('all');

  const load = useCallback(async () => {
    try {
      setStats(await authedFetch<PointStats>('/scoring/admin/point-stats'));
      setError(null);
    } catch {
      setError('Impossible de charger les statistiques.');
    }
  }, [authedFetch]);

  useEffect(() => {
    if (!loading && user?.isAdmin) void load();
  }, [loading, user, load]);

  const topPlayers = useMemo(
    () =>
      (stats?.topPlayers ?? []).filter(
        (player) => gameFilter === 'all' || player.gameId === gameFilter,
      ),
    [stats, gameFilter],
  );

  if (loading) return null;
  if (!user?.isAdmin) {
    return (
      <main className={styles.main}>
        <p className={styles.denied}>Accès réservé à l’administration.</p>
      </main>
    );
  }

  const maxGame = Math.max(1, ...(stats?.byGame ?? []).map((g) => g.avgPoints));
  const maxRole = Math.max(1, ...(stats?.byRole ?? []).map((r) => r.avgPoints));

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Santé des points fantasy</h1>
        {stats && (
          <span className={styles.generatedAt}>Actualisé à {formatDateTime(stats.generatedAt)}</span>
        )}
      </div>
      <p className={styles.intro}>
        Système Z-score v1 : les notes sont standardisées par jeu (et par rôle en LoL), donc chaque
        moyenne jeu/rôle doit tomber ≈ 50. Un écart notable signale une distribution ou un pilier à
        revoir. La liste des mieux notés aide à repérer les incohérences.
      </p>
      {error && <p className={styles.error}>{error}</p>}
      {!stats && !error && <p>Chargement…</p>}

      {stats && (
        <>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Moyenne de points par jeu</h2>
            {stats.byGame.length === 0 ? (
              <p className={styles.empty}>Aucun point calculé.</p>
            ) : (
              <div className={styles.bars}>
                {stats.byGame.map((game) => (
                  <Bar
                    key={game.gameId}
                    label={gameLabel(game.gameId)}
                    value={game.avgPoints}
                    max={maxGame}
                    sub={`${game.scores} notes`}
                  />
                ))}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Moyenne de points par rôle (LoL)</h2>
            {stats.byRole.length === 0 ? (
              <p className={styles.empty}>Aucun point LoL calculé.</p>
            ) : (
              <div className={styles.bars}>
                {stats.byRole.map((role) => (
                  <Bar
                    key={role.role}
                    label={role.role}
                    value={role.avgPoints}
                    max={maxRole}
                    sub={`${role.players} joueurs · ${role.scores} notes`}
                  />
                ))}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.headerRow}>
              <h2 className={styles.sectionTitle}>
                Joueurs par moyenne (≥ {stats.minScores} matchs notés)
              </h2>
              <div className={styles.filterRow}>
                <button
                  className={gameFilter === 'all' ? styles.filterChipActive : styles.filterChip}
                  onClick={() => setGameFilter('all')}
                >
                  Tous
                </button>
                {GAME_IDS.map((gameId) => (
                  <button
                    key={gameId}
                    className={gameFilter === gameId ? styles.filterChipActive : styles.filterChip}
                    onClick={() => setGameFilter(gameId)}
                  >
                    {gameLabel(gameId)}
                  </button>
                ))}
              </div>
            </div>
            <p className={styles.hint}>
              Les moyennes ne sont pas comparables entre jeux (barèmes différents) : filtre par jeu.
            </p>
            {topPlayers.length === 0 ? (
              <p className={styles.empty}>Aucun joueur sur ce périmètre.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.rank}>#</th>
                      <th>Joueur</th>
                      <th>Jeu</th>
                      <th>Rôle</th>
                      <th>Équipe</th>
                      <th className={styles.num}>Moy.</th>
                      <th className={styles.num}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topPlayers.map((player, index) => (
                      <tr key={player.playerId}>
                        <td className={styles.rank}>{index + 1}</td>
                        <td>
                          <Link className={styles.playerLink} href={`/players/${player.playerId}`}>
                            {player.name}
                          </Link>
                        </td>
                        <td>{gameLabel(player.gameId)}</td>
                        <td>{player.role ?? '·'}</td>
                        <td>{player.team ?? '·'}</td>
                        <td className={`${styles.num} ${styles.avg}`}>
                          {player.avgPoints.toFixed(2)}
                        </td>
                        <td className={styles.num}>{player.scores}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
