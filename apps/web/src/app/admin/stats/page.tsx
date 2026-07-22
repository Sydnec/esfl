'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { formatDateTime } from '@/lib/format';
import styles from './page.module.css';

interface Bucket {
  from: number;
  to: number;
  count: number;
}

interface GameDist {
  gameId: GameId;
  count: number;
  mean: number;
  min: number;
  max: number;
  buckets: Bucket[];
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
  bucketSize: number;
  distributions: GameDist[];
  topPlayers: TopPlayer[];
}

function gameLabel(gameId: string): string {
  return GAME_LABELS[gameId as GameId] ?? gameId;
}

/** Histogramme vertical d'une distribution de notes (0-100). */
function Histogram({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <div className={styles.histoWrap}>
      <div className={styles.histo}>
        <span className={styles.mid} aria-hidden />
        {buckets.map((bucket) => (
          <span
            key={bucket.from}
            className={styles.bar}
            style={{ height: `${(bucket.count / max) * 100}%` }}
            title={`${bucket.from}–${bucket.to} : ${bucket.count}`}
          />
        ))}
      </div>
      <div className={styles.axis}>
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>
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

  // Distribution du périmètre sélectionné (un jeu, ou tous cumulés).
  const selected = useMemo(() => {
    const dists = stats?.distributions ?? [];
    if (dists.length === 0) return null;
    if (gameFilter !== 'all') return dists.find((dist) => dist.gameId === gameFilter) ?? null;
    const size = dists[0].buckets.length;
    const buckets = Array.from({ length: size }, (_, index) => ({
      from: dists[0].buckets[index].from,
      to: dists[0].buckets[index].to,
      count: dists.reduce((sum, dist) => sum + (dist.buckets[index]?.count ?? 0), 0),
    }));
    const count = dists.reduce((sum, dist) => sum + dist.count, 0);
    return {
      gameId: 'all' as GameId,
      count,
      mean: count ? Math.round((dists.reduce((s, d) => s + d.mean * d.count, 0) / count) * 10) / 10 : 0,
      min: Math.min(...dists.map((dist) => dist.min)),
      max: Math.max(...dists.map((dist) => dist.max)),
      buckets,
    };
  }, [stats, gameFilter]);

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

  const availableGames = GAME_IDS.filter((gameId) =>
    (stats?.distributions ?? []).some((dist) => dist.gameId === gameId),
  );

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Santé des points fantasy</h1>
        {stats && (
          <span className={styles.generatedAt}>Actualisé à {formatDateTime(stats.generatedAt)}</span>
        )}
      </div>
      <p className={styles.intro}>
        Système Z-score v1 : les notes sont standardisées par jeu (et par rôle en LoL). La
        distribution doit s’étaler autour de 50, avec de vrais extrêmes (des notes proches de 0 et de
        100). Un histogramme trop tassé signale un manque de contraste (échelle à revoir).
      </p>
      {error && <p className={styles.error}>{error}</p>}
      {!stats && !error && <p>Chargement…</p>}

      {stats && (
        <>
          <div className={styles.filterRow}>
            <button
              className={gameFilter === 'all' ? styles.filterChipActive : styles.filterChip}
              onClick={() => setGameFilter('all')}
            >
              Tous
            </button>
            {availableGames.map((gameId) => (
              <button
                key={gameId}
                className={gameFilter === gameId ? styles.filterChipActive : styles.filterChip}
                onClick={() => setGameFilter(gameId)}
              >
                {gameLabel(gameId)}
              </button>
            ))}
          </div>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Distribution des notes</h2>
            {!selected || selected.count === 0 ? (
              <p className={styles.empty}>Aucune note calculée.</p>
            ) : (
              <>
                <Histogram buckets={selected.buckets} />
                <p className={styles.distMeta}>
                  {selected.count} notes · moyenne {selected.mean} · min {selected.min} · max{' '}
                  {selected.max}
                </p>
              </>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Joueurs par moyenne (≥ {stats.minScores} matchs notés)
            </h2>
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
                          {player.avgPoints.toFixed(1)}
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
