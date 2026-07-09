'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GAME_LABELS } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { request } from '@/lib/api';
import { flagEmoji } from '@/lib/flags';
import { formatKickoff } from '@/lib/format';
import { formatStat, STAT_COLUMNS } from '@/lib/stat-columns';
import type { FantasyPointsLine, MatchStatsLine, MatchSummary, PlayerRef } from '@/lib/types';
import styles from './page.module.css';

const POLL_INTERVAL_MS = 30_000;

/** Durée d'une manche : « 32 min ». */
function formatLength(lengthSec: number | null | undefined): string {
  if (!lengthSec) return '';
  return `${Math.round(lengthSec / 60)} min`;
}

export default function MatchPage() {
  const { id } = useParams<{ id: string }>();
  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [stats, setStats] = useState<MatchStatsLine[]>([]);
  const [players, setPlayers] = useState<Map<string, PlayerRef>>(new Map());
  const [points, setPoints] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const detail = await request<MatchSummary>(`/data/matches/${id}`);
      setMatch(detail);
      if (detail.status === 'finished') {
        const lines = await request<MatchStatsLine[]>(`/data/stats?matchIds=${id}`);
        setStats(lines);
        if (lines.length > 0) {
          const ids = lines.map((line) => line.playerId).join(',');
          const [refs, fantasyPoints] = await Promise.all([
            request<PlayerRef[]>(`/data/players/by-ids?ids=${ids}`),
            request<FantasyPointsLine[]>(`/scoring/players?playerIds=${ids}`),
          ]);
          setPlayers(new Map(refs.map((player) => [player.id, player])));
          setPoints(
            new Map(
              fantasyPoints
                .filter((line) => line.matchId === id)
                .map((line) => [line.playerId, line.points]),
            ),
          );
        }
      }
    } catch {
      setError('Match introuvable');
    }
  }, [id]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (error) return <main className={styles.main}>{error}</main>;
  if (!match) return <main className={styles.main}>Chargement…</main>;

  const running = match.status === 'running';
  const finished = match.status === 'finished';
  const tagA = match.teamA?.acronym || match.teamA?.name || 'TBD';
  const tagB = match.teamB?.acronym || match.teamB?.name || 'TBD';
  const games = match.gamesSummary ?? [];

  const statsByTeam = (teamId: string | null | undefined) =>
    stats.filter((line) => {
      const player = players.get(line.playerId);
      return player?.team?.id && player.team.id === teamId;
    });

  return (
    <main className={styles.main}>
      <p className={styles.context}>
        {GAME_LABELS[match.gameId]} · {match.competition.name}
        {match.name ? ` · ${match.name}` : ''}
      </p>

      <div className={styles.scoreboard}>
        {/* Live/stream en haut à droite : cliquable quand un stream existe. */}
        <span className={styles.corner}>
          {running &&
            (match.streamUrl ? (
              <a className={styles.liveLink} href={match.streamUrl} target="_blank" rel="noreferrer">
                ● live
              </a>
            ) : (
              <span className={styles.live}>● live</span>
            ))}
        </span>

        {/* Grille symétrique à emplacements fixes : logo · nom/tag · drapeau
            vs drapeau · nom/tag · logo (les cases restent en place même vides). */}
        <div className={styles.teamsRow}>
          <span className={styles.slotLogo}>
            {match.teamA && <Avatar src={match.teamA.imageUrl} label={match.teamA.name} size={40} />}
          </span>
          <span className={styles.slotName}>
            <span className={styles.teamName}>{match.teamA?.name ?? 'TBD'} <span className={styles.slotFlag}>{flagEmoji(match.teamA?.location)}</span></span>
            {match.teamA?.acronym && <span className={styles.teamTag}>{match.teamA.acronym}</span>}
          </span>
          <span className={styles.center}>
            {match.bestOf && <span className={styles.bestOf}>BO{match.bestOf}</span>}
            <span className={styles.bigScore}>
              {finished || running ? `${match.scoreA ?? 0} vs ${match.scoreB ?? 0}` : 'vs'}
            </span>
            <span className={styles.when}>
              {finished ? 'Terminé' : running ? 'En cours' : formatKickoff(match.scheduledAt)}
            </span>
          </span>
          <span className={`${styles.slotName} ${styles.slotNameRight}`}>
            <span className={styles.teamName}><span className={styles.slotFlag}>{flagEmoji(match.teamB?.location)}</span> {match.teamB?.name ?? 'TBD'}</span>
            {match.teamB?.acronym && <span className={styles.teamTag}>{match.teamB.acronym}</span>}
          </span>
          <span className={styles.slotLogo}>
            {match.teamB && <Avatar src={match.teamB.imageUrl} label={match.teamB.name} size={40} />}
          </span>
        </div>
      </div>

      {games.length > 0 && (
        <ul className={styles.games}>
          {games.map((game) => (
            <li key={game.position} className={styles.game}>
              <span className={styles.gameName}>
                M{game.position}
                {game.map ? ` · ${game.map}` : ''}
              </span>
              <span className={styles.gameScore}>
                {game.scoreA != null && game.scoreB != null
                  ? `${game.scoreA} vs ${game.scoreB}${match.gameId === 'lol' ? ' kills' : ''}`
                  : game.winner
                    ? `victoire ${game.winner === 'A' ? tagA : tagB}`
                    : 'en cours'}
              </span>
              <span className={styles.gameLength}>{formatLength(game.lengthSec)}</span>
            </li>
          ))}
        </ul>
      )}

      {finished && stats.length > 0 && (
        <section className={styles.statsSection}>
          <h2 className={styles.statsTitle}>Performances</h2>
          {[match.teamA, match.teamB].map((team) => {
            const lines = statsByTeam(team?.id);
            if (!team || lines.length === 0) return null;
            const columns = STAT_COLUMNS[match.gameId];
            return (
              <div key={team.id} className={styles.teamStats}>
                <h3 className={styles.teamStatsTitle}>
                  {team.name} {flagEmoji(team.location)}
                </h3>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Joueur</th>
                      {columns.map((column) => (
                        <th key={column.key}>{column.label}</th>
                      ))}
                      <th>Pts fantasy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const player = players.get(line.playerId);
                      return (
                        <tr key={line.playerId}>
                          <td>
                            <Link className={styles.playerCell} href={`/players/${line.playerId}`}>
                              <Avatar
                                src={player?.imageUrl}
                                fallbackSrc={player?.team?.imageUrl}
                                label={player?.name ?? '?'}
                                size={24}
                              />
                              {player?.name ?? 'Inconnu'} {flagEmoji(player?.nationality)}
                            </Link>
                          </td>
                          {columns.map((column) => (
                            <td key={column.key}>{formatStat(line.normalized[column.key])}</td>
                          ))}
                          <td className={styles.points}>{points.get(line.playerId) ?? '·'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      )}

      {finished && stats.length === 0 && (
        <p className={styles.pending}>
          Statistiques des joueurs en cours de récupération, repasse un peu plus tard.
        </p>
      )}
    </main>
  );
}
