'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GAME_IDS, GAME_SHORT_LABELS, GameId } from '@esfl/contracts';
import { request } from '@/lib/api';
import type { Competition, MatchSummary } from '@/lib/types';
import { MatchGrid } from './MatchCard';
import styles from './MatchesOverview.module.css';

/** Compétitions décochées par l'utilisateur (les nouvelles restent visibles par défaut). */
const FILTER_STORAGE_KEY = 'esfl.competitionFilter.excluded';
const POLL_INTERVAL_MS = 60_000;
/** Fenêtre affichée : terminés depuis moins de 24h et à venir sous 24h. */
const WINDOW_MS = 24 * 3600 * 1000;

function loadExcluded(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    return new Set(JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Tri chronologique par heure de début au sein de chaque section. */
function displayOrder(matches: MatchSummary[]): MatchSummary[] {
  return [...matches].sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
}

export function MatchesOverview() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const loadMatches = useCallback(() => {
    const from = new Date(Date.now() - WINDOW_MS).toISOString();
    const to = new Date(Date.now() + WINDOW_MS).toISOString();
    return request<MatchSummary[]>(`/data/matches?from=${from}&to=${to}`)
      .then(setMatches)
      .catch(() => setError('Planning indisponible pour le moment'));
  }, []);

  useEffect(() => {
    setExcluded(loadExcluded());
    request<Competition[]>('/data/competitions')
      .then(setCompetitions)
      .catch(() => undefined);
    void loadMatches();
    // Actualisation périodique : débuts, scores live et fins de match sans reload.
    const interval = setInterval(() => {
      if (!document.hidden) void loadMatches();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadMatches]);

  function toggleCompetition(id: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const visible = useMemo(
    () => matches.filter((match) => !excluded.has(match.competition.id)),
    [matches, excluded],
  );

  if (error) {
    return <p className={styles.empty}>{error}</p>;
  }

  return (
    <section className={styles.overview}>
      <div className={styles.headerRow}>
        <h2 className={styles.title}>Les matchs</h2>
        <button className={styles.filterToggle} onClick={() => setFilterOpen((open) => !open)}>
          Filtrer{excluded.size > 0 ? ` (${excluded.size} masquée(s))` : ''}
        </button>
      </div>

      {filterOpen && (
        <div className={styles.filterPanel}>
          {GAME_IDS.map((gameId: GameId) => {
            const list = competitions.filter((competition) => competition.gameId === gameId);
            if (list.length === 0) return null;
            return (
              <div key={gameId} className={styles.filterGroup}>
                <h3 className={styles.filterGame}>{GAME_SHORT_LABELS[gameId]}</h3>
                {list.map((competition) => (
                  <label key={competition.id} className={styles.filterItem}>
                    <input
                      type="checkbox"
                      checked={!excluded.has(competition.id)}
                      onChange={() => toggleCompetition(competition.id)}
                    />
                    <span>{competition.name}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {visible.length === 0 ? (
        <p className={styles.empty}>Aucun match sur les dernières 24h ni les prochaines.</p>
      ) : (
        GAME_IDS.map((gameId: GameId) => {
          const ofGame = visible.filter((match) => match.gameId === gameId);
          if (ofGame.length === 0) return null;
          const byCompetition = new Map<string, MatchSummary[]>();
          for (const match of ofGame) {
            const key = match.competition.id;
            byCompetition.set(key, [...(byCompetition.get(key) ?? []), match]);
          }
          return (
            <div key={gameId} className={styles.gameGroup}>
              <h3 className={styles.gameTitle}>{GAME_SHORT_LABELS[gameId]}</h3>
              {[...byCompetition.values()].map((competitionMatches) => (
                <div key={competitionMatches[0].competition.id} className={styles.compGroup}>
                  <h4 className={styles.compTitle}>{competitionMatches[0].competition.name}</h4>
                  <MatchGrid matches={displayOrder(competitionMatches)} />
                </div>
              ))}
            </div>
          );
        })
      )}
    </section>
  );
}
