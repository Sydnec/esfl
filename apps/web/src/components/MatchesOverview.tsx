'use client';

import { useEffect, useMemo, useState } from 'react';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { request } from '@/lib/api';
import type { Competition, MatchSummary } from '@/lib/types';
import styles from './MatchesOverview.module.css';

/** Compétitions décochées par l'utilisateur (les nouvelles restent visibles par défaut). */
const FILTER_STORAGE_KEY = 'esfl.competitionFilter.excluded';

function loadExcluded(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    return new Set(JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Tag court de l'équipe (MDR, G2…), replié sur le nom complet si absent. */
function teamTag(team: { name: string; acronym: string | null } | null): string {
  return team?.acronym || team?.name || '?';
}

function MatchRow({ match }: { match: MatchSummary }) {
  return (
    <li className={styles.match}>
      <span className={styles.matchGame}>{GAME_LABELS[match.gameId]}</span>
      <span className={styles.matchTeams} title={`${match.teamA?.name ?? '?'} vs ${match.teamB?.name ?? '?'}`}>
        {teamTag(match.teamA)} vs {teamTag(match.teamB)}
        {match.status === 'finished' && (
          <strong className={styles.score}>
            {' '}
            {match.scoreA} : {match.scoreB}
          </strong>
        )}
      </span>
      <span className={styles.matchMeta}>
        {match.competition.name} · {formatDate(match.scheduledAt)}
      </span>
    </li>
  );
}

export function MatchesOverview() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    setExcluded(loadExcluded());
    const from = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    Promise.all([
      request<Competition[]>('/data/competitions'),
      request<MatchSummary[]>(`/data/matches?from=${from}&to=${to}`),
    ])
      .then(([comps, ms]) => {
        setCompetitions(comps);
        setMatches(ms);
      })
      .catch(() => setError('Planning indisponible pour le moment'));
  }, []);

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
  const now = Date.now();
  const running = visible.filter((match) => match.status === 'running');
  const recent = visible
    .filter((match) => match.status === 'finished')
    .sort((a, b) => (b.scheduledAt ?? '').localeCompare(a.scheduledAt ?? ''))
    .slice(0, 15);
  const upcoming = visible
    .filter(
      (match) =>
        match.status === 'not_started' &&
        match.scheduledAt &&
        new Date(match.scheduledAt).getTime() > now - 3600 * 1000,
    )
    .slice(0, 20);

  if (error) {
    return <p className={styles.empty}>{error}</p>;
  }

  return (
    <section className={styles.overview}>
      <div className={styles.headerRow}>
        <h2 className={styles.title}>Les matchs</h2>
        <button className={styles.filterToggle} onClick={() => setFilterOpen((open) => !open)}>
          Filtrer les compétitions{excluded.size > 0 ? ` (${excluded.size} masquée(s))` : ''}
        </button>
      </div>

      {filterOpen && (
        <div className={styles.filterPanel}>
          {GAME_IDS.map((gameId: GameId) => {
            const list = competitions.filter((competition) => competition.gameId === gameId);
            if (list.length === 0) return null;
            return (
              <div key={gameId} className={styles.filterGroup}>
                <h3 className={styles.filterGame}>{GAME_LABELS[gameId]}</h3>
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

      {running.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>En cours</h3>
          <ul className={styles.matches}>
            {running.map((match) => (
              <MatchRow key={match.id} match={match} />
            ))}
          </ul>
        </>
      )}

      <h3 className={styles.sectionTitle}>À venir</h3>
      {upcoming.length === 0 ? (
        <p className={styles.empty}>Aucun match à venir sur les compétitions affichées.</p>
      ) : (
        <ul className={styles.matches}>
          {upcoming.map((match) => (
            <MatchRow key={match.id} match={match} />
          ))}
        </ul>
      )}

      <h3 className={styles.sectionTitle}>Récents</h3>
      {recent.length === 0 ? (
        <p className={styles.empty}>Aucun match récent sur les compétitions affichées.</p>
      ) : (
        <ul className={styles.matches}>
          {recent.map((match) => (
            <MatchRow key={match.id} match={match} />
          ))}
        </ul>
      )}
    </section>
  );
}
