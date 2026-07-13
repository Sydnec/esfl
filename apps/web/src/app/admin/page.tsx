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

interface JobFailure {
  id: string | null;
  job: string;
  jobLabel: string;
  matchId: string | null;
  gameId: string | null;
  cible: string | null;
  introuvable: boolean;
  raison: string | null;
  tentatives: number;
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
    echecs: JobFailure[];
  };
  aliases: Array<{ gameId: string; name: string; aliases: string[] }>;
  pandascore: { requetesDerniereHeure: number; quotaHoraire: number };
}

type Tab = 'dashboard' | 'gestion';

function gameLabel(gameId: string): string {
  return GAME_LABELS[gameId as GameId] ?? gameId;
}

function coverage(row: { finis: number; avecStats: number } | undefined): string {
  if (!row || row.finis === 0) return '—';
  return `${row.avecStats}/${row.finis} (${Math.round((row.avecStats / row.finis) * 100)} %)`;
}

/** Total finis / avec stats sur la fenêtre 48h, tous jeux confondus. */
function totalCoverage(parJeu: IngestionHealth['parJeu']): { finis: number; avecStats: number } {
  return Object.values(parJeu).reduce(
    (acc, row) => ({ finis: acc.finis + row.finis, avecStats: acc.avecStats + row.avecStats }),
    { finis: 0, avecStats: 0 },
  );
}

export default function AdminPage() {
  const { user, loading, authedFetch } = useAuth();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [health, setHealth] = useState<IngestionHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  /** URL VLR saisie par match (matchs Valorant sans stats). */
  const [vlrUrl, setVlrUrl] = useState<Record<string, string>>({});

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

  async function setStatsPage(matchId: string) {
    const url = (vlrUrl[matchId] ?? '').trim();
    if (!url) return;
    setPending(matchId);
    setError(null);
    try {
      await authedFetch(`/data/admin/matches/${matchId}/stats-page?url=${encodeURIComponent(url)}`, {
        method: 'POST',
      });
      setVlrUrl((current) => ({ ...current, [matchId]: '' }));
      await load();
    } catch {
      setError('Page VLR invalide ou match introuvable');
    } finally {
      setPending(null);
    }
  }

  async function retrigger(matchId: string, force: boolean) {
    setPending(matchId);
    setNotice(null);
    try {
      await authedFetch(`/data/admin/ingest-stats/${matchId}${force ? '?force=true' : ''}`, {
        method: 'POST',
      });
      setNotice('Ingestion relancée.');
      await load();
    } catch {
      setError('Relance impossible');
    } finally {
      setPending(null);
    }
  }

  async function reingestMissing() {
    setPending('reingest-missing');
    setError(null);
    try {
      const { enqueued } = await authedFetch<{ enqueued: number; days: number }>(
        '/data/admin/reingest-missing',
        { method: 'POST' },
      );
      setNotice(
        enqueued === 0
          ? 'Aucun match récupérable à relancer.'
          : `${enqueued} match(s) relancé(s) — les stats réapparaîtront au fil de l’ingestion.`,
      );
      await load();
    } catch {
      setError('Relance en masse impossible');
    } finally {
      setPending(null);
    }
  }

  async function pruneFailures() {
    setPending('prune-failures');
    setError(null);
    try {
      const { removed } = await authedFetch<{ removed: number }>(
        '/data/admin/queue/prune-failures',
        { method: 'POST' },
      );
      setNotice(
        removed === 0
          ? 'Aucun échec obsolète à supprimer.'
          : `${removed} échec(s) obsolète(s) supprimé(s).`,
      );
      await load();
    } catch {
      setError('Purge des échecs impossible');
    } finally {
      setPending(null);
    }
  }

  async function forceSync(job: string) {
    setPending(job);
    setNotice(null);
    try {
      await authedFetch(`/data/admin/sync/${job}`, { method: 'POST' });
      setNotice('Synchronisation lancée.');
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

  const totals = health ? totalCoverage(health.parJeu) : { finis: 0, avecStats: 0 };
  const enCoursTotal = health ? Object.values(health.parJeu).reduce((n, r) => n + r.enCours, 0) : 0;

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Administration</h1>
        {health && (
          <span className={styles.generatedAt}>
            Actualisé à {formatDateTime(health.generatedAt)}
          </span>
        )}
      </div>

      <nav className={styles.tabs}>
        <button
          className={tab === 'dashboard' ? styles.tabActive : styles.tab}
          onClick={() => setTab('dashboard')}
        >
          Tableau de bord
        </button>
        <button
          className={tab === 'gestion' ? styles.tabActive : styles.tab}
          onClick={() => setTab('gestion')}
        >
          Gestion manuelle
          {health && health.queue.failed > 0 && (
            <span className={styles.tabBadge}>{health.queue.failed}</span>
          )}
        </button>
      </nav>

      {error && <p className={styles.error}>{error}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}
      {!health && !error && <p>Chargement…</p>}

      {health && tab === 'dashboard' && (
        <>
          <section className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Couverture stats (48 h)</span>
              <span
                className={
                  totals.avecStats < totals.finis ? styles.tileAlert : styles.tileValue
                }
              >
                {coverage(totals)}
              </span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Matchs en cours</span>
              <span className={styles.tileValue}>{enCoursTotal}</span>
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
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Quota Pandascore (1 h)</span>
              <span className={styles.tileValue}>
                {health.pandascore.requetesDerniereHeure} / {health.pandascore.quotaHoraire}
              </span>
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Activité par jeu</h2>
            <div className={styles.tableWrap}>
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
                        <td>
                          <span className={styles.badge} data-game={source.gameId}>
                            {gameLabel(source.gameId)}
                          </span>
                        </td>
                        <td>{row?.enCours ?? 0}</td>
                        <td>{row?.aVenir24h ?? 0}</td>
                        <td>{row?.finis ?? 0}</td>
                        <td className={row && row.avecStats < row.finis ? styles.warn : undefined}>
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
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>En ce moment ({health.enCours.length})</h2>
            {health.enCours.length === 0 ? (
              <p className={styles.empty}>Aucun match en cours.</p>
            ) : (
              <div className={styles.tableWrap}>
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
                        <td>
                          <span className={styles.badge} data-game={match.gameId}>
                            {gameLabel(match.gameId)}
                          </span>
                        </td>
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
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Catalogue</h2>
            <div className={styles.tableWrap}>
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
                      <td>
                        <span className={styles.badge} data-game={gameId}>
                          {gameLabel(gameId)}
                        </span>
                      </td>
                      <td>{row.competitions}</td>
                      <td>{row.suivies ?? '—'}</td>
                      <td>{row.equipes}</td>
                      <td>{row.joueurs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {Object.keys(health.catalogue).length === 0 && (
              <p className={styles.empty}>Catalogue vide — le sync initial est en cours.</p>
            )}
          </section>
        </>
      )}

      {health && tab === 'gestion' && (
        <>
          <section className={styles.section}>
            <div className={styles.headerRow}>
              <h2 className={styles.sectionTitle}>
                Matchs finis sans stats ({health.sansStats.length})
              </h2>
              <button
                className={styles.action}
                disabled={pending === 'reingest-missing'}
                onClick={() => void reingestMissing()}
              >
                {pending === 'reingest-missing'
                  ? 'Relance en cours…'
                  : 'Relancer tous les récupérables'}
              </button>
            </div>
            <p className={styles.hint}>
              Matchs suivis, finis dans les 48 h, sans stats. « Relancer » réenfile l’ingestion ;
              le bouton en masse relance d’un coup tous ceux qui ont une couverture.
            </p>
            {health.sansStats.length === 0 ? (
              <p className={styles.empty}>Tous les matchs récents ont leurs stats.</p>
            ) : (
              <div className={styles.tableWrap}>
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
                        <td>
                          <span className={styles.badge} data-game={match.gameId}>
                            {gameLabel(match.gameId)}
                          </span>
                        </td>
                        <td>
                          <Link href={`/matches/${match.id}`}>{match.name}</Link>
                        </td>
                        <td>{match.endAt ? formatDateTime(match.endAt) : '—'}</td>
                        <td>
                          {match.gameId !== 'cs2' ? (
                            '—'
                          ) : match.gridCovered === false ? (
                            <span className={styles.warn}>hors couverture</span>
                          ) : match.gridCovered ? (
                            <span className={styles.ok}>couvert</span>
                          ) : (
                            'à vérifier'
                          )}
                        </td>
                        <td>
                          <div className={styles.searchRow}>
                            <button
                              className={styles.action}
                              disabled={pending === match.id}
                              onClick={() => void retrigger(match.id, false)}
                            >
                              Relancer
                            </button>
                            {match.gameId === 'valorant' && (
                              <>
                                <input
                                  className={styles.searchInput}
                                  placeholder="page VLR.gg…"
                                  value={vlrUrl[match.id] ?? ''}
                                  onChange={(event) =>
                                    setVlrUrl((current) => ({
                                      ...current,
                                      [match.id]: event.target.value,
                                    }))
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') void setStatsPage(match.id);
                                  }}
                                />
                                <button
                                  className={styles.action}
                                  disabled={
                                    pending === match.id || !(vlrUrl[match.id] ?? '').trim()
                                  }
                                  onClick={() => void setStatsPage(match.id)}
                                >
                                  Appliquer
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.headerRow}>
              <h2 className={styles.sectionTitle}>
                Échecs de jobs ({health.queue.echecs.length})
              </h2>
              {health.queue.echecs.some((echec) => echec.introuvable) && (
                <button
                  className={styles.action}
                  disabled={pending === 'prune-failures'}
                  onClick={() => void pruneFailures()}
                >
                  {pending === 'prune-failures' ? 'Nettoyage…' : 'Nettoyer les obsolètes'}
                </button>
              )}
            </div>
            {health.queue.echecs.length === 0 ? (
              <p className={styles.empty}>Aucun job en échec.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Tâche</th>
                      <th>Cible</th>
                      <th>Raison</th>
                      <th>Tentatives</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {health.queue.echecs.map((echec) => (
                      <tr key={echec.id ?? `${echec.job}-${echec.cible}`}>
                        <td>{echec.jobLabel}</td>
                        <td>
                          {echec.introuvable ? (
                            <span className={styles.empty}>Match supprimé (obsolète)</span>
                          ) : echec.matchId ? (
                            <>
                              {echec.gameId && (
                                <span className={styles.badge} data-game={echec.gameId}>
                                  {gameLabel(echec.gameId)}
                                </span>
                              )}{' '}
                              <Link href={`/matches/${echec.matchId}`}>{echec.cible}</Link>
                            </>
                          ) : (
                            (echec.cible ?? '—')
                          )}
                        </td>
                        <td className={styles.reason}>{echec.raison ?? '—'}</td>
                        <td>{echec.tentatives}</td>
                        <td>
                          {echec.matchId && (
                            <button
                              className={styles.action}
                              disabled={pending === echec.matchId}
                              onClick={() => void retrigger(echec.matchId as string, true)}
                            >
                              Relancer
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Synchronisations forcées</h2>
            <p className={styles.hint}>
              Relance immédiate d’un cycle de synchronisation (normalement planifié
              automatiquement).
            </p>
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
            <h2 className={styles.sectionTitle}>
              Alias d’équipes appris ({health.aliases.length})
            </h2>
            {health.aliases.length === 0 ? (
              <p className={styles.empty}>Aucun alias appris pour l’instant.</p>
            ) : (
              <div className={styles.tableWrap}>
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
                        <td>
                          <span className={styles.badge} data-game={team.gameId}>
                            {gameLabel(team.gameId)}
                          </span>
                        </td>
                        <td>{team.name}</td>
                        <td>{team.aliases.join(', ')}</td>
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
