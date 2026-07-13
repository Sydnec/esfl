'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { formatDateTime } from '@/lib/format';
import styles from './page.module.css';

interface MatchHit {
  id: string;
  gameId: string;
  name: string;
  status: string;
  endAt: string | null;
  statsPageUrl: string | null;
  hasStats: boolean;
}

function gameLabel(gameId: string): string {
  return GAME_LABELS[gameId as GameId] ?? gameId;
}

/**
 * Recherche d'un match par nom pour agir dessus hors de la fenêtre 48h du
 * tableau de santé : relancer l'ingestion, ou (Valorant) coller la page VLR.
 */
export function MatchFinder() {
  const { authedFetch } = useAuth();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<MatchHit[]>([]);
  const [vlrUrl, setVlrUrl] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const search = useCallback(async () => {
    if (query.trim().length < 2) {
      setMatches([]);
      return;
    }
    try {
      setMatches(
        await authedFetch<MatchHit[]>(`/data/admin/matches?search=${encodeURIComponent(query.trim())}`),
      );
    } catch {
      setMatches([]);
    }
  }, [authedFetch, query]);

  useEffect(() => {
    const timer = setTimeout(() => void search(), 350);
    return () => clearTimeout(timer);
  }, [search]);

  async function retrigger(id: string) {
    setBusy(id);
    setNote(null);
    try {
      await authedFetch(`/data/admin/ingest-stats/${id}?force=true`, { method: 'POST' });
      setNote('Ingestion relancée.');
      await search();
    } catch {
      setNote('Relance impossible');
    } finally {
      setBusy(null);
    }
  }

  async function applyUrl(match: MatchHit) {
    const url = (vlrUrl[match.id] ?? '').trim();
    if (!url) return;
    setBusy(match.id);
    setNote(null);
    try {
      await authedFetch(`/data/admin/matches/${match.id}/stats-page?url=${encodeURIComponent(url)}`, {
        method: 'POST',
      });
      setVlrUrl((current) => ({ ...current, [match.id]: '' }));
      setNote(`Page VLR appliquée à « ${match.name} » — ingestion relancée.`);
      await search();
    } catch {
      setNote('Page VLR invalide ou match introuvable');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Chercher un match</h2>
      <p className={styles.hint}>
        Pour agir sur un match plus ancien que la liste ci-dessus : relancer l’ingestion, ou coller
        la page VLR.gg d’un match Valorant.
      </p>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder="Nom du match (équipe, tour…)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {note && <p className={styles.note}>{note}</p>}
      {matches.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Jeu</th>
              <th>Match</th>
              <th>Statut</th>
              <th>Stats</th>
              <th>Fin</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {matches.map((match) => (
              <tr key={match.id}>
                <td>{gameLabel(match.gameId)}</td>
                <td>
                  <Link href={`/matches/${match.id}`}>{match.name}</Link>
                </td>
                <td>{match.status}</td>
                <td>{match.hasStats ? '✓' : <span className={styles.warn}>—</span>}</td>
                <td>{match.endAt ? formatDateTime(match.endAt) : '—'}</td>
                <td>
                  <div className={styles.searchRow}>
                    <button
                      className={styles.action}
                      disabled={busy === match.id}
                      onClick={() => void retrigger(match.id)}
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
                            setVlrUrl((current) => ({ ...current, [match.id]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void applyUrl(match);
                          }}
                        />
                        <button
                          className={styles.action}
                          disabled={busy === match.id || !(vlrUrl[match.id] ?? '').trim()}
                          onClick={() => void applyUrl(match)}
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
      )}
    </section>
  );
}
