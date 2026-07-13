'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { formatDateTime } from '@/lib/format';
import { TeamMatcher } from './TeamMatcher';
import styles from './page.module.css';

const REFRESH_INTERVAL_MS = 60_000;

interface HealthMatch {
  id: string;
  gameId: string;
  name: string;
  endAt: string | null;
  gridCovered: boolean | null;
}

interface RunningMatch {
  id: string;
  gameId: string;
  name: string;
  beginAt: string | null;
  statsMaj: string | null;
}

const SYNC_JOBS: Array<{ job: string; label: string }> = [
  { job: 'sync-series', label: 'Catalogue des compétitions' },
  { job: 'sync-matches', label: 'Matchs (toutes compétitions actives)' },
  { job: 'sync-rosters', label: 'Rosters' },
  { job: 'sync-live', label: 'Fenêtre live (scores, statuts)' },
  { job: 'sync-live-stats', label: 'Stats live' },
  { job: 'check-grid-coverage', label: 'Couverture Grid (CS2)' },
];

interface IngestionHealth {
  generatedAt: string;
  parJeu: Record<
    string,
    { enCours: number; aVenir24h: number; finis: number; avecStats: number }
  >;
  couverture7j: Record<string, { finis: number; avecStats: number }>;
  enCours: RunningMatch[];
  catalogue: Record<
    string,
    { competitions: number; suivies: number | null; equipes: number; joueurs: number }
  >;
  sources: Array<{ gameId: string; source: string; configuree: boolean; live: boolean }>;
  sansStats: HealthMatch[];
  couvertureGrid: { couverts: number; horsCouverture: number; aVerifier: number };
  queue: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    echecs: Array<{
      name: string;
      data: Record<string, unknown>;
      raison: string | null;
      tentatives: number;
    }>;
  };
  aliases: Array<{ gameId: string; name: string; aliases: string[] }>;
  pandascore: { requetesDerniereHeure: number; quotaHoraire: number };
}

function gameLabel(gameId: string): string {
  return GAME_LABELS[gameId as GameId] ?? gameId;
}

function coverage(row: { finis: number; avecStats: number } | undefined): string {
  if (!row || row.finis === 0) return '—';
  return `${row.avecStats}/${row.finis} (${Math.round((row.avecStats / row.finis) * 100)} %)`;
}

export default function AdminPage() {
  const { user, loading, authedFetch } = useAuth();
  const [health, setHealth] = useState<IngestionHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHealth(await authedFetch<IngestionHealth>('/data/admin/health'));
      setError(null);
    } catch {
      setError('Impossible de charger la santé de l’ingestion');
    }
  }, [authedFetch]);

  useEffect(() => {
    if (loading || !user?.isAdmin) return;
    void load();
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loading, user, load]);

  async function retrigger(matchId: string, force: boolean) {
    setPending(matchId);
    try {
      await authedFetch(`/data/admin/ingest-stats/${matchId}${force ? '?force=true' : ''}`, {
        method: 'POST',
      });
      await load();
    } catch {
      setError('Relance impossible');
    } finally {
      setPending(null);
    }
  }

  async function forceSync(job: string) {
    setPending(job);
    try {
      await authedFetch(`/data/admin/sync/${job}`, { method: 'POST' });
      setError(null);
    } catch {
      setError(`Impossible de lancer ${job}`);
    } finally {
      setPending(null);
    }
  }

  if (loading) return null;
  if (!user?.isAdmin) {
    return (
      <main className={styles.main}>
        <p className={styles.denied}>Accès réservé à l’administration.</p>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Santé de l’ingestion</h1>
        {health && (
          <span className={styles.generatedAt}>
            Actualisé à {formatDateTime(health.generatedAt)}
          </span>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {!health && !error && <p>Chargement…</p>}
      {health && (
        <>
          <section className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Quota Pandascore (1 h)</span>
              <span className={styles.tileValue}>
                {health.pandascore.requetesDerniereHeure} / {health.pandascore.quotaHoraire}
              </span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Queue — en cours / retry</span>
              <span className={styles.tileValue}>
                {health.queue.waiting + health.queue.active} / {health.queue.delayed}
              </span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Jobs en échec</span>
              <span className={health.queue.failed > 0 ? styles.tileAlert : styles.tileValue}>
                {health.queue.failed}
              </span>
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Synchronisations forcées</h2>
            <div className={styles.actions}>
              {SYNC_JOBS.map(({ job, label }) => (
                <button
                  key={job}
                  className={styles.action}
                  disabled={pending === job}
                  onClick={() => void forceSync(job)}
                >
                  {pending === job ? 'Lancement…' : label}
                </button>
              ))}
            </div>
          </section>

          <TeamMatcher />

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Activité par jeu</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Jeu</th>
                  <th>En cours</th>
                  <th>À venir (24 h)</th>
                  <th>Finis (48 h)</th>
                  <th>Avec stats</th>
                  <th>Couverture (7 j)</th>
                  <th>Source stats</th>
                </tr>
              </thead>
              <tbody>
                {health.sources.map((source) => {
                  const row = health.parJeu[source.gameId];
                  const cover = health.couverture7j[source.gameId];
                  const incomplete = cover && cover.avecStats < cover.finis;
                  return (
                    <tr key={source.gameId}>
                      <td>{gameLabel(source.gameId)}</td>
                      <td>{row?.enCours ?? 0}</td>
                      <td>{row?.aVenir24h ?? 0}</td>
                      <td>{row?.finis ?? 0}</td>
                      <td
                        className={
                          row && row.avecStats < row.finis ? styles.warn : undefined
                        }
                      >
                        {row?.avecStats ?? 0}
                      </td>
                      <td className={incomplete ? styles.warn : undefined}>{coverage(cover)}</td>
                      <td>
                        {source.source}
                        {source.live ? ' (live)' : ''} —{' '}
                        {source.configuree ? (
                          <span className={styles.ok}>configurée</span>
                        ) : (
                          <span className={styles.warn}>clé manquante</span>
                        )}
                        {source.gameId === 'cs2' && (
                          <span className={styles.gridDetail}>
                            {' '}
                            · Grid : {health.couvertureGrid.couverts} ✓,{' '}
                            {health.couvertureGrid.horsCouverture} ✗,{' '}
                            {health.couvertureGrid.aVerifier} ?
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>En ce moment ({health.enCours.length})</h2>
            {health.enCours.length === 0 ? (
              <p className={styles.empty}>Aucun match en cours.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Jeu</th>
                    <th>Match</th>
                    <th>Début</th>
                    <th>Stats live</th>
                  </tr>
                </thead>
                <tbody>
                  {health.enCours.map((match) => (
                    <tr key={match.id}>
                      <td>{gameLabel(match.gameId)}</td>
                      <td>
                        <Link href={`/matches/${match.id}`}>{match.name}</Link>
                      </td>
                      <td>{match.beginAt ? formatDateTime(match.beginAt) : '—'}</td>
                      <td>
                        {match.statsMaj ? (
                          `maj ${formatDateTime(match.statsMaj)}`
                        ) : (
                          <span className={styles.warn}>aucune</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Catalogue</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Jeu</th>
                  <th>Compétitions</th>
                  <th>Suivies</th>
                  <th>Équipes</th>
                  <th>Joueurs</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(health.catalogue).map(([gameId, row]) => (
                  <tr key={gameId}>
                    <td>{gameLabel(gameId)}</td>
                    <td>{row.competitions}</td>
                    <td>{row.suivies ?? '—'}</td>
                    <td>{row.equipes}</td>
                    <td>{row.joueurs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Object.keys(health.catalogue).length === 0 && (
              <p className={styles.empty}>Catalogue vide — le sync initial est en cours.</p>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Matchs finis sans stats ({health.sansStats.length})
            </h2>
            {health.sansStats.length === 0 ? (
              <p className={styles.empty}>Tous les matchs récents ont leurs stats.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Jeu</th>
                    <th>Match</th>
                    <th>Fin</th>
                    <th>Grid</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {health.sansStats.map((match) => (
                    <tr key={match.id}>
                      <td>{gameLabel(match.gameId)}</td>
                      <td>
                        <Link href={`/matches/${match.id}`}>{match.name}</Link>
                      </td>
                      <td>{match.endAt ? formatDateTime(match.endAt) : '—'}</td>
                      <td>
                        {match.gameId !== 'cs2'
                          ? '—'
                          : match.gridCovered === false
                            ? 'hors couverture'
                            : match.gridCovered
                              ? 'couvert'
                              : 'à vérifier'}
                      </td>
                      <td>
                        <button
                          className={styles.action}
                          disabled={pending === match.id}
                          onClick={() => void retrigger(match.id, false)}
                        >
                          Relancer
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {health.queue.echecs.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Échecs de jobs</h2>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Données</th>
                    <th>Raison</th>
                    <th>Tentatives</th>
                  </tr>
                </thead>
                <tbody>
                  {health.queue.echecs.map((echec, index) => (
                    <tr key={index}>
                      <td>{echec.name}</td>
                      <td className={styles.mono}>{JSON.stringify(echec.data)}</td>
                      <td>{echec.raison ?? '—'}</td>
                      <td>{echec.tentatives}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Alias d’équipes appris ({health.aliases.length})
            </h2>
            {health.aliases.length === 0 ? (
              <p className={styles.empty}>Aucun alias appris pour l’instant.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Jeu</th>
                    <th>Équipe (Pandascore)</th>
                    <th>Alias provider</th>
                  </tr>
                </thead>
                <tbody>
                  {health.aliases.map((team) => (
                    <tr key={`${team.gameId}-${team.name}`}>
                      <td>{gameLabel(team.gameId)}</td>
                      <td>{team.name}</td>
                      <td>{team.aliases.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
