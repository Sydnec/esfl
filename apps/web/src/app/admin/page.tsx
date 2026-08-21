'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { API_URL } from '@/lib/api';
import { gameProfile } from '@/lib/game-profile';
import { formatDateTime } from '@/lib/format';
import { datesDeRattrapage } from './degel-rattrapage';
import { TeamMatcher } from './TeamMatcher';
import styles from './page.module.css';

const REFRESH_INTERVAL_MS = 60_000;

interface HealthMatch {
  id: string;
  gameId: string;
  name: string;
  endAt: string | null;
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
];

const STATE_LABELS: Record<QueueJob['state'], string> = {
  active: 'En cours',
  delayed: 'Retry programmé',
  waiting: 'En attente',
  failed: 'En échec',
};

interface QueueJob {
  id: string | null;
  job: string;
  jobLabel: string;
  state: 'active' | 'delayed' | 'waiting' | 'failed';
  matchId: string | null;
  gameId: string | null;
  cible: string | null;
  introuvable: boolean;
  recurrent: boolean;
  raison: string | null;
  tentatives: number;
}

interface QueueSnapshot {
  counts: Record<string, number>;
  jobs: QueueJob[];
}

/** Réponse de `/health` du gateway : ce qui tourne réellement côté API. */
interface IdentiteApi {
  version: string;
  commit: string;
}

interface IngestionHealth {
  generatedAt: string;
  parJeu: Record<string, { enCours: number; aVenir24h: number; finis: number; avecStats: number }>;
  couverture7j: Record<string, { finis: number; avecStats: number }>;
  enCours: RunningMatch[];
  catalogue: Record<
    string,
    {
      competitions: number;
      equipes: number;
      equipesAvecIdProvider: number;
      joueurs: number;
      joueursAvecIdProvider: number;
      joueursAvecIdPandascore: number;
    }
  >;
  sources: Array<{ gameId: string; source: string; configuree: boolean; live: boolean }>;
  sansStats: HealthMatch[];
  /** Matchs finis que la source n'a jamais eus : aucun arbitrage possible. */
  sansRecours: number;
  queue: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    echecs: JobFailure[];
  };
  aliases: Array<{ gameId: string; name: string; aliases: string[] }>;
}

type Tab = 'dashboard' | 'gestion' | 'queue';

function gameLabel(gameId: string): string {
  return GAME_LABELS[gameId as GameId] ?? gameId;
}

function coverage(row: { finis: number; avecStats: number } | undefined): string {
  if (!row || row.finis === 0) return 'aucun';
  return `${row.avecStats}/${row.finis} (${Math.round((row.avecStats / row.finis) * 100)} %)`;
}

/** « 45/50 » : rapprochés / total (rapprochement des ids provider/Pandascore). */
function matched(withId: number, total: number): string {
  if (total === 0) return '·';
  return `${withId}/${total}`;
}

export default function AdminPage() {
  const { user, loading, authedFetch } = useAuth();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [health, setHealth] = useState<IngestionHealth | null>(null);
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  /** Version de l'API en service (null tant qu'elle n'a pas répondu). */
  const [api, setApi] = useState<IdentiteApi | null>(null);
  /** URL VLR saisie par match (matchs Valorant sans stats). */
  const [vlrUrl, setVlrUrl] = useState<Record<string, string>>({});
  /** TEMPORAIRE — fenêtre du dégel de rattrapage, figée pour la visite. */
  const fenetreDegel = useMemo(() => datesDeRattrapage(), []);

  const load = useCallback(async () => {
    try {
      setHealth(await authedFetch<IngestionHealth>('/data/admin/health'));
      setError(null);
    } catch {
      setError('Impossible de charger la santé de l’ingestion');
    }
  }, [authedFetch]);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await authedFetch<QueueSnapshot>('/data/admin/queue'));
    } catch {
      setError('Impossible de charger la file d’attente');
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

  // Lu une seule fois : la version ne change qu'au redéploiement, qui recharge
  // de toute façon la page. Sonde publique du gateway, donc sans jeton — et
  // c'est bien l'API qu'on interroge, pas le front, déployé séparément.
  useEffect(() => {
    if (loading || !user?.isAdmin) return;
    let annule = false;
    void fetch(`${API_URL}/health`)
      .then((response) => (response.ok ? (response.json() as Promise<IdentiteApi>) : null))
      .then((identite) => {
        if (!annule) setApi(identite);
      })
      .catch(() => undefined);
    return () => {
      annule = true;
    };
  }, [loading, user]);

  // La file n'est rafraîchie que quand son onglet est ouvert (requêtes Redis).
  useEffect(() => {
    if (loading || !user?.isAdmin || tab !== 'queue') return;
    void loadQueue();
    const interval = setInterval(() => {
      if (!document.hidden) void loadQueue();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loading, user, tab, loadQueue]);

  async function setStatsPage(matchId: string) {
    const url = (vlrUrl[matchId] ?? '').trim();
    if (!url) return;
    setPending(matchId);
    setError(null);
    try {
      await authedFetch(
        `/data/admin/matches/${matchId}/stats-page?url=${encodeURIComponent(url)}`,
        {
          method: 'POST',
        },
      );
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
      if (tab === 'queue') await loadQueue();
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
          : `${enqueued} match(s) relancé(s), les stats réapparaîtront au fil de l’ingestion.`,
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

  /** Remet un job épuisé en file, une fois sa cause corrigée. */
  async function retryJob(jobId: string) {
    setPending(`retry-${jobId}`);
    setError(null);
    try {
      await authedFetch(`/data/admin/queue/jobs/${encodeURIComponent(jobId)}/retry`, {
        method: 'POST',
      });
      setNotice('Job remis en file.');
      await loadQueue();
    } catch {
      setError('Rejeu du job impossible');
    } finally {
      setPending(null);
    }
  }

  async function cleanQueue(
    state: 'completed' | 'failed' | 'pending' | 'all',
    confirmLabel?: string,
  ) {
    if (confirmLabel && !window.confirm(confirmLabel)) return;
    setPending(`clean-${state}`);
    setError(null);
    try {
      const { removed } = await authedFetch<{ removed: number }>(
        `/data/admin/queue/clean?state=${state}`,
        { method: 'POST' },
      );
      setNotice(removed === 0 ? 'Aucun job à retirer.' : `${removed} job(s) retiré(s) de la file.`);
      await loadQueue();
      await load();
    } catch {
      setError('Nettoyage de la file impossible');
    } finally {
      setPending(null);
    }
  }

  /**
   * TEMPORAIRE — à supprimer avec `degel-rattrapage.ts`. Dégèle la fenêtre
   * gelée trop tôt par l'ancienne échéance, puis relance le rattrapage des
   * notes manquantes.
   */
  async function degelerRattrapage() {
    const dates = fenetreDegel;
    if (!window.confirm(`Dégeler les journées ${dates.at(-1)} → ${dates[0]} et re-noter ?`)) return;
    setPending('degel-rattrapage');
    setError(null);
    setNotice(null);
    try {
      for (const date of dates) {
        await authedFetch(`/scoring/admin/freeze/${date}`, { method: 'DELETE' });
      }
      const { missing, scored } = await authedFetch<{ missing: number; scored: number }>(
        '/scoring/admin/backfill-scores',
        { method: 'POST' },
      );
      setNotice(
        `${dates.length} journée(s) dégelée(s) — ${scored} match(s) noté(s) sur ${missing} sans note.`,
      );
    } catch {
      setError('Dégel de rattrapage impossible');
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

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Administration</h1>
        <div className={styles.headerMeta}>
          {api && (
            <span className={styles.version} title={`Commit ${api.commit}`}>
              API v{api.version} · {api.commit}
            </span>
          )}
          {health && (
            <span className={styles.generatedAt}>
              Actualisé à {formatDateTime(health.generatedAt)}
            </span>
          )}
        </div>
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
        <button
          className={tab === 'queue' ? styles.tabActive : styles.tab}
          onClick={() => setTab('queue')}
        >
          File d’attente
        </button>
      </nav>

      {error && <p className={styles.error}>{error}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}
      {!health && !error && <p>Chargement…</p>}

      {health && tab === 'dashboard' && (
        <>
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
                          {source.live ? ' (live)' : ''} :{' '}
                          {source.configuree ? (
                            <span className={styles.ok}>configurée</span>
                          ) : (
                            <span className={styles.warn}>clé manquante</span>
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
                        <td>{match.beginAt ? formatDateTime(match.beginAt) : ''}</td>
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
            <p className={styles.hint}>
              « x/y » = fiches rapprochées / total : id provider appris (équipes, joueurs) et id
              Pandascore posé par adoption (joueurs, nés côté provider).
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Jeu</th>
                    <th>Compétitions</th>
                    <th>Équipes</th>
                    <th title="Équipes dont l'identifiant provider est connu">dont id provider</th>
                    <th>Joueurs</th>
                    <th title="Joueurs dont l'identifiant provider est connu">dont id provider</th>
                    <th title="Joueurs adoptés par Pandascore (photo, nationalité...)">
                      dont id Pandascore
                    </th>
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
                      <td>{row.equipes}</td>
                      <td>{matched(row.equipesAvecIdProvider, row.equipes)}</td>
                      <td>{row.joueurs}</td>
                      <td>{matched(row.joueursAvecIdProvider, row.joueurs)}</td>
                      <td>{matched(row.joueursAvecIdPandascore, row.joueurs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {Object.keys(health.catalogue).length === 0 && (
              <p className={styles.empty}>Catalogue vide, le sync initial est en cours.</p>
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
              Matchs suivis, finis dans les 48 h, sans stats. « Relancer » réenfile l’ingestion ; le
              bouton en masse les relance tous d’un coup.
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
                        <td>{match.endAt ? formatDateTime(match.endAt) : ''}</td>
                        <td>
                          <div className={styles.searchRow}>
                            <button
                              className={styles.action}
                              disabled={pending === match.id}
                              onClick={() => void retrigger(match.id, false)}
                            >
                              Relancer
                            </button>
                            {gameProfile(match.gameId).correctionParLien && (
                              <>
                                <input
                                  className={styles.searchInput}
                                  placeholder="lien de la page du match…"
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
              <h2 className={styles.sectionTitle}>Échecs de jobs ({health.queue.echecs.length})</h2>
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
                            (echec.cible ?? '')
                          )}
                        </td>
                        <td className={styles.reason}>{echec.raison ?? ''}</td>
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

          {/* TEMPORAIRE — à supprimer avec `degel-rattrapage.ts` et
              `degelerRattrapage`. */}
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Dégel de rattrapage (temporaire)</h2>
            <p className={styles.hint}>
              L’échéance du gel est passée de 3 à 7 jours. Les journées gelées sous l’ancienne règle
              le restent, et leurs matchs dont les stats sont arrivées après coup n’ont jamais eu de
              note. Ce bouton rouvre {fenetreDegel.at(-1)} → {fenetreDegel[0]}, puis relance le
              rattrapage des notes. Le gel automatique refermera ces journées de lui-même, après un
              dernier re-score. À retirer une fois le rattrapage fait.
            </p>
            <div className={styles.actions}>
              <button
                className={styles.action}
                disabled={pending === 'degel-rattrapage'}
                onClick={() => void degelerRattrapage()}
              >
                {pending === 'degel-rattrapage'
                  ? 'Dégel en cours…'
                  : 'Dégeler la fenêtre et re-noter'}
              </button>
            </div>
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

          <TeamMatcher sansRecours={health?.sansRecours ?? 0} />

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

      {tab === 'queue' && (
        <>
          {!queue && !error && <p>Chargement…</p>}
          {queue && (
            <>
              <section className={styles.tiles}>
                <div className={styles.tile}>
                  <span className={styles.tileLabel}>En attente</span>
                  <span className={styles.tileValue}>{queue.counts.waiting ?? 0}</span>
                </div>
                <div className={styles.tile}>
                  <span className={styles.tileLabel}>En cours</span>
                  <span className={styles.tileValue}>{queue.counts.active ?? 0}</span>
                </div>
                <div className={styles.tile}>
                  <span className={styles.tileLabel}>Retry programmés</span>
                  <span className={styles.tileValue}>{queue.counts.delayed ?? 0}</span>
                </div>
                <div className={styles.tile}>
                  <span className={styles.tileLabel}>En échec</span>
                  <span
                    className={(queue.counts.failed ?? 0) > 0 ? styles.tileAlert : styles.tileValue}
                  >
                    {queue.counts.failed ?? 0}
                  </span>
                </div>
                <div className={styles.tile}>
                  <span className={styles.tileLabel}>Terminés</span>
                  <span className={styles.tileValue}>{queue.counts.completed ?? 0}</span>
                </div>
              </section>

              <section className={styles.section}>
                <div className={styles.headerRow}>
                  <h2 className={styles.sectionTitle}>Jobs dans la file ({queue.jobs.length})</h2>
                  <button
                    className={styles.action}
                    disabled={pending === 'queue-refresh'}
                    onClick={() => void loadQueue()}
                  >
                    Rafraîchir
                  </button>
                </div>
                <p className={styles.hint}>
                  Les jobs des synchronisations planifiées (récurrents) et les jobs en cours sont
                  toujours préservés par les purges : seuls les jobs terminés, en échec ou en
                  attente ponctuels sont retirés.
                </p>
                <div className={styles.actions}>
                  <button
                    className={styles.action}
                    disabled={pending === 'clean-completed'}
                    onClick={() => void cleanQueue('completed')}
                  >
                    {pending === 'clean-completed' ? 'Nettoyage…' : 'Nettoyer les terminés'}
                  </button>
                  <button
                    className={styles.action}
                    disabled={pending === 'clean-failed'}
                    onClick={() => void cleanQueue('failed')}
                  >
                    {pending === 'clean-failed' ? 'Nettoyage…' : 'Nettoyer les échecs'}
                  </button>
                  <button
                    className={styles.action}
                    disabled={pending === 'clean-pending'}
                    onClick={() =>
                      void cleanQueue(
                        'pending',
                        'Retirer tous les jobs en attente et retries programmés (hors syncs récurrents) ?',
                      )
                    }
                  >
                    {pending === 'clean-pending' ? 'Nettoyage…' : 'Vider les jobs en attente'}
                  </button>
                  <button
                    className={styles.dangerAction}
                    disabled={pending === 'clean-all'}
                    onClick={() =>
                      void cleanQueue(
                        'all',
                        'Vider entièrement la file (terminés, échecs, en attente et retries) ? Les syncs planifiés et les jobs en cours sont conservés.',
                      )
                    }
                  >
                    {pending === 'clean-all' ? 'Nettoyage…' : 'Tout vider'}
                  </button>
                </div>
                {queue.jobs.length === 0 ? (
                  <p className={styles.empty}>Aucun job dans la file.</p>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>État</th>
                          <th>Tâche</th>
                          <th>Cible</th>
                          <th>Tentatives</th>
                          <th>Détail</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {queue.jobs.map((job) => (
                          <tr key={job.id ?? `${job.job}-${job.state}-${job.cible}`}>
                            <td>
                              <span className={styles.badge} data-state={job.state}>
                                {STATE_LABELS[job.state]}
                              </span>
                            </td>
                            <td>
                              {job.jobLabel}
                              {job.recurrent && (
                                <span className={styles.gridDetail}> · récurrent</span>
                              )}
                            </td>
                            <td>
                              {job.introuvable ? (
                                <span className={styles.empty}>Match supprimé (obsolète)</span>
                              ) : job.matchId ? (
                                <>
                                  {job.gameId && (
                                    <span className={styles.badge} data-game={job.gameId}>
                                      {gameLabel(job.gameId)}
                                    </span>
                                  )}{' '}
                                  <Link href={`/matches/${job.matchId}`}>{job.cible}</Link>
                                </>
                              ) : (
                                (job.cible ?? '')
                              )}
                            </td>
                            <td>{job.tentatives}</td>
                            <td className={styles.reason}>{job.raison ?? ''}</td>
                            <td>
                              {job.matchId ? (
                                <button
                                  className={styles.action}
                                  disabled={pending === job.matchId}
                                  onClick={() => void retrigger(job.matchId as string, true)}
                                >
                                  Relancer
                                </button>
                              ) : (
                                // Sans match cible, rien ne reconstruit le job :
                                // le rejouer est le seul rattrapage.
                                job.state === 'failed' &&
                                job.id && (
                                  <button
                                    className={styles.action}
                                    disabled={pending === `retry-${job.id}`}
                                    onClick={() => void retryJob(job.id as string)}
                                  >
                                    Rejouer
                                  </button>
                                )
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
