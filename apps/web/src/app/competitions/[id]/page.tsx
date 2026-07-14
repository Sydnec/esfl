'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GAME_LABELS } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { MatchGrid } from '@/components/MatchCard';
import { BracketDiagram } from '@/components/BracketDiagram';
import { StandingsTable } from '@/components/StandingsTable';
import { request } from '@/lib/api';
import { flagEmoji } from '@/lib/flags';
import type { CompetitionDetail, MatchSummary, PlayerRef } from '@/lib/types';
import styles from './page.module.css';

const POLL_INTERVAL_MS = 60_000;

/** Une phase est un arbre si ses matchs portent des noms de tour (finale, demi…). */
const BRACKET_RE = /grand ?final|\bfinale?\b|semi.?final|demi.?finale|quarter.?final|\bquart|round of \d|1\/\d/i;

/** Période lisible : « 15 juin – 20 juil. 2026 ». */
function formatPeriod(beginAt: string | null, endAt: string | null): string {
  const options = { day: 'numeric', month: 'short' } as const;
  const begin = beginAt ? new Date(beginAt).toLocaleDateString('fr-FR', options) : null;
  const end = endAt
    ? new Date(endAt).toLocaleDateString('fr-FR', { ...options, year: 'numeric' })
    : null;
  if (begin && end) return `${begin} – ${end}`;
  return begin ?? end ?? '';
}

export default function CompetitionPage() {
  const { id } = useParams<{ id: string }>();
  const [competition, setCompetition] = useState<CompetitionDetail | null>(null);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [players, setPlayers] = useState<PlayerRef[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, matchList, playerList] = await Promise.all([
        request<CompetitionDetail>(`/data/competitions/${id}`),
        request<MatchSummary[]>(`/data/matches?competitionIds=${id}`),
        request<PlayerRef[]>(`/data/players?competitionIds=${id}`),
      ]);
      setCompetition(detail);
      setMatches(matchList);
      setPlayers(playerList);
    } catch {
      setError('Compétition introuvable');
    }
  }, [id]);

  useEffect(() => {
    void load();
    // Scores live : même rythme que l'accueil.
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Matchs regroupés par phase de tournoi (poule/playoffs), triées chronologiquement.
  const phases = useMemo(() => {
    const groups = new Map<
      number,
      { id: number; name: string; matches: MatchSummary[]; firstAt: number }
    >();
    for (const match of matches) {
      if (match.tournamentId == null) continue;
      const group = groups.get(match.tournamentId) ?? {
        id: match.tournamentId,
        name: match.tournamentName ?? 'Phase',
        matches: [],
        firstAt: Infinity,
      };
      group.matches.push(match);
      group.firstAt = Math.min(group.firstAt, match.scheduledAt ? Date.parse(match.scheduledAt) : Infinity);
      groups.set(match.tournamentId, group);
    }
    return [...groups.values()].sort((a, b) => a.firstAt - b.firstAt);
  }, [matches]);

  // Matchs sans phase connue (données anciennes / jeux sans tournois) : repli en grille.
  const ungrouped = useMemo(() => matches.filter((match) => match.tournamentId == null), [matches]);
  const upcoming = useMemo(
    () => ungrouped.filter((match) => match.status !== 'finished' && match.status !== 'canceled'),
    [ungrouped],
  );
  const finished = useMemo(
    () => [...ungrouped.filter((match) => match.status === 'finished')].reverse(),
    [ungrouped],
  );

  const playersByTeam = useMemo(() => {
    const groups = new Map<string, PlayerRef[]>();
    for (const player of players) {
      const key = player.team?.id ?? 'sans-equipe';
      groups.set(key, [...(groups.get(key) ?? []), player]);
    }
    return groups;
  }, [players]);

  if (error) return <main className={styles.main}>{error}</main>;
  if (!competition) return <main className={styles.main}>Chargement…</main>;

  const period = formatPeriod(competition.beginAt, competition.endAt);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Avatar src={competition.imageUrl} label={competition.name} size={64} />
        <div className={styles.identity}>
          <h1 className={styles.name}>{competition.name}</h1>
          <p className={styles.meta}>
            {GAME_LABELS[competition.gameId]}
            {competition.tier ? ` · tier ${competition.tier.toUpperCase()}` : ''}
            {period ? ` · ${period}` : ''}
          </p>
        </div>
      </header>

      {phases.map((phase) =>
        BRACKET_RE.test(phase.matches.map((m) => m.name).join(' ')) ? (
          <section key={phase.id} className={styles.section}>
            <h2 className={styles.sectionTitle}>{phase.name}</h2>
            <BracketDiagram matches={phase.matches} />
          </section>
        ) : (
          <section key={phase.id} className={styles.section}>
            <h2 className={styles.sectionTitle}>{phase.name}</h2>
            <StandingsTable matches={phase.matches} />
            <div className={styles.phaseMatches}>
              <MatchGrid
                matches={[...phase.matches].sort((a, b) =>
                  (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''),
                )}
              />
            </div>
          </section>
        ),
      )}

      {upcoming.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>En cours & à venir</h2>
          <MatchGrid matches={upcoming} />
        </section>
      )}

      {finished.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Résultats récents</h2>
          <MatchGrid matches={finished} />
        </section>
      )}

      {matches.length === 0 && <p className={styles.empty}>Aucun match référencé.</p>}

      {competition.teams.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Équipes & joueurs</h2>
          <ul className={styles.teams}>
            {competition.teams.map(({ team }) => (
              <li key={team.id} className={styles.teamCard}>
                <span className={styles.teamHeader}>
                  <Avatar src={team.imageUrl} label={team.name} size={28} />
                  <span className={styles.teamName}>
                    {team.name} {flagEmoji(team.location)}
                  </span>
                </span>
                <ul className={styles.teamPlayers}>
                  {(playersByTeam.get(team.id) ?? []).map((player) => (
                    <li key={player.id}>
                      <Link className={styles.playerLink} href={`/players/${player.id}`}>
                        {player.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
