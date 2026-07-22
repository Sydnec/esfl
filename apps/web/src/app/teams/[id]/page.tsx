'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GAME_LABELS } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { MatchGrid } from '@/components/MatchCard';
import { request } from '@/lib/api';
import { flagEmoji } from '@/lib/flags';
import { sortTeamPlayers } from '@/lib/roles';
import { useMatchUpdates } from '@/lib/useMatchUpdates';
import type { MatchSummary, TeamDetail } from '@/lib/types';
import styles from './page.module.css';

const POLL_INTERVAL_MS = 60_000;

/** Bilan sur les matchs terminés : le forfait compte comme les autres. */
function bilan(matches: MatchSummary[], teamId: string) {
  const joues = matches.filter((match) => match.status === 'finished');
  const gagnes = joues.filter((match) => match.winnerTeamId === teamId).length;
  // Un match nul n'existe pas dans ces jeux, mais un vainqueur peut manquer
  // (données incomplètes) : on ne le compte ni en victoire ni en défaite.
  const perdus = joues.filter(
    (match) => match.winnerTeamId != null && match.winnerTeamId !== teamId,
  ).length;
  const decides = gagnes + perdus;
  return {
    joues: joues.length,
    gagnes,
    perdus,
    ratio: decides > 0 ? Math.round((gagnes / decides) * 100) : null,
  };
}

export default function TeamPage() {
  const { id } = useParams<{ id: string }>();
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, matchList] = await Promise.all([
        request<TeamDetail>(`/data/teams/${id}`),
        request<MatchSummary[]>(`/data/matches?teamId=${id}`),
      ]);
      setTeam(detail);
      setMatches(matchList);
    } catch {
      setError('Équipe introuvable');
    }
  }, [id]);

  useEffect(() => {
    void load();
    // Scores live : même rythme que l'accueil et la page compétition.
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Mise à jour instantanée des scores via SSE, lissée à 3 s.
  const dernierRafraichissement = useRef(0);
  useMatchUpdates(() => {
    if (Date.now() - dernierRafraichissement.current < 3_000) return;
    dernierRafraichissement.current = Date.now();
    void load();
  });

  const effectif = useMemo(() => sortTeamPlayers(team?.players ?? []), [team]);
  const aVenir = useMemo(
    () => matches.filter((match) => match.status !== 'finished' && match.status !== 'canceled'),
    [matches],
  );
  // Du plus récent au plus ancien : `listMatches` trie par date croissante.
  const termines = useMemo(
    () => [...matches.filter((match) => match.status === 'finished')].reverse(),
    [matches],
  );

  if (error) return <main className={styles.main}>{error}</main>;
  if (!team) return <main className={styles.main}>Chargement…</main>;

  const resultats = bilan(matches, team.id);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Avatar src={team.imageUrl} label={team.name} size={64} />
        <div className={styles.identity}>
          <h1 className={styles.name}>
            {team.name} {flagEmoji(team.location)}
          </h1>
          <p className={styles.meta}>
            {GAME_LABELS[team.gameId]}
            {team.acronym ? ` · ${team.acronym}` : ''}
          </p>
        </div>
      </header>

      {resultats.joues > 0 && (
        <dl className={styles.summary}>
          <div className={styles.summaryItem}>
            <dt>Matchs joués</dt>
            <dd>{resultats.joues}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Bilan</dt>
            <dd>
              {resultats.gagnes} V / {resultats.perdus} D
            </dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Victoires</dt>
            <dd>{resultats.ratio == null ? '·' : `${resultats.ratio} %`}</dd>
          </div>
        </dl>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Effectif</h2>
        {effectif.length === 0 ? (
          <p className={styles.empty}>Aucun joueur référencé.</p>
        ) : (
          <ul className={styles.roster}>
            {effectif.map((player) => (
              <li key={player.id}>
                <Link className={styles.playerCard} href={`/players/${player.id}`}>
                  <Avatar
                    src={player.imageUrl}
                    fallbackSrc={team.imageUrl}
                    label={player.name}
                    size={32}
                    fit="cover"
                  />
                  <span className={styles.playerIdentity}>
                    <span className={styles.playerName}>
                      {player.name} {flagEmoji(player.nationality)}
                    </span>
                    {player.role && <span className={styles.playerRole}>{player.role}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {team.competitions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Compétitions</h2>
          <ul className={styles.competitions}>
            {team.competitions.map((competition) => (
              <li key={competition.id}>
                <Link className={styles.competitionCard} href={`/competitions/${competition.id}`}>
                  <Avatar src={competition.imageUrl} label={competition.name} size={24} />
                  <span className={styles.competitionName}>{competition.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {aVenir.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>En cours &amp; à venir</h2>
          <MatchGrid matches={aVenir} />
        </section>
      )}

      {termines.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Résultats récents</h2>
          <MatchGrid matches={termines} />
        </section>
      )}

      {matches.length === 0 && <p className={styles.empty}>Aucun match référencé.</p>}
    </main>
  );
}
