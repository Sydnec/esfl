'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GAME_IDS, GAME_SHORT_LABELS, GameId } from '@esfl/contracts';
import { request } from '@/lib/api';
import { formatKickoff } from '@/lib/format';
import type { Competition, MatchSummary, TeamRef } from '@/lib/types';
import { Avatar } from './Avatar';
import styles from './MatchesOverview.module.css';

/** Compétitions décochées par l'utilisateur (les nouvelles restent visibles par défaut). */
const FILTER_STORAGE_KEY = 'esfl.competitionFilter.excluded';
const POLL_INTERVAL_MS = 60_000;

function loadExcluded(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    return new Set(JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function teamTag(team: TeamRef | null): string {
  return team?.acronym || team?.name || 'TBD';
}

function TeamChip({ team }: { team: TeamRef | null }) {
  if (!team) {
    return <span className={styles.tbd}>TBD</span>;
  }
  return (
    <span className={styles.teamChip} title={team.name}>
      <Avatar src={team.imageUrl} label={team.name} size={18} />
      {teamTag(team)}
    </span>
  );
}

export function MatchRow({ match }: { match: MatchSummary }) {
  const finished = match.status === 'finished';
  const running = match.status === 'running';
  return (
    <li>
      <Link href={`/matches/${match.id}`} className={styles.match}>
        <span className={styles.matchTeams}>
          <TeamChip team={match.teamA} />
          {finished && <strong className={styles.score}>{match.scoreA}</strong>}
          <span className={styles.vs}>vs</span>
          {finished && <strong className={styles.score}>{match.scoreB}</strong>}
          <TeamChip team={match.teamB} />
        </span>
        <span className={styles.matchMeta}>
          {running ? <span className={styles.live}>● live</span> : formatKickoff(match.scheduledAt)}
        </span>
      </Link>
    </li>
  );
}

/** Liste groupée jeu → compétition, sans répéter l'info sur chaque ligne. */
function GroupedMatches({ matches }: { matches: MatchSummary[] }) {
  return (
    <>
      {GAME_IDS.map((gameId: GameId) => {
        const ofGame = matches.filter((match) => match.gameId === gameId);
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
                <ul className={styles.matches}>
                  {competitionMatches.map((match) => (
                    <MatchRow key={match.id} match={match} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function MatchesOverview() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const loadMatches = useCallback(() => {
    const from = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
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
    // Actualisation périodique : les débuts/fins de match apparaissent sans reload.
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
  const now = Date.now();
  // Les matchs en cours sont intégrés en tête de la colonne « À venir ».
  const upcoming = [
    ...visible.filter((match) => match.status === 'running'),
    ...visible
      .filter(
        (match) =>
          match.status === 'not_started' &&
          match.scheduledAt &&
          new Date(match.scheduledAt).getTime() > now - 3600 * 1000,
      )
      .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''))
      .slice(0, 30),
  ];
  const recent = visible
    .filter((match) => match.status === 'finished')
    .sort((a, b) => (b.scheduledAt ?? '').localeCompare(a.scheduledAt ?? ''))
    .slice(0, 30);

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

      <div className={styles.columns}>
        <div>
          <h2 className={styles.columnTitle}>À venir</h2>
          {upcoming.length === 0 ? (
            <p className={styles.empty}>Aucun match à venir sur les compétitions affichées.</p>
          ) : (
            <GroupedMatches matches={upcoming} />
          )}
        </div>
        <div>
          <h2 className={styles.columnTitle}>Récents</h2>
          {recent.length === 0 ? (
            <p className={styles.empty}>Aucun match récent sur les compétitions affichées.</p>
          ) : (
            <GroupedMatches matches={recent} />
          )}
        </div>
      </div>
    </section>
  );
}
