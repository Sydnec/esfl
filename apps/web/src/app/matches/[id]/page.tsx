'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { GAME_LABELS, GameId } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { request } from '@/lib/api';
import { flagEmoji } from '@/lib/flags';
import { formatKickoff } from '@/lib/format';
import type {
  FantasyPointsLine,
  MatchStatsLine,
  MatchSummary,
  PlayerRef,
  TeamRef,
} from '@/lib/types';
import styles from './page.module.css';

const POLL_INTERVAL_MS = 30_000;

/** Colonnes de stats par jeu (clé du normalized + libellé court). */
const STAT_COLUMNS: Record<GameId, Array<{ key: string; label: string }>> = {
  cs2: [
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'adr', label: 'ADR' },
  ],
  valorant: [
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'acs', label: 'ACS' },
    { key: 'firstKills', label: 'FK' },
  ],
  lol: [
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'csPerMin', label: 'CS/min' },
    { key: 'win', label: 'Résultat' },
  ],
  rl: [
    { key: 'goals', label: 'Buts' },
    { key: 'assists', label: 'Passes' },
    { key: 'saves', label: 'Arrêts' },
    { key: 'shots', label: 'Tirs' },
    { key: 'score', label: 'Score' },
  ],
};

function formatStat(value: number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '·';
  if (typeof value === 'boolean') return value ? 'V' : 'D';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function TeamHeader({ team, side }: { team: TeamRef | null; side: 'A' | 'B' }) {
  if (!team) {
    return <span className={styles.tbd}>TBD</span>;
  }
  return (
    <span className={`${styles.teamHeader} ${side === 'B' ? styles.reverse : ''}`}>
      <Avatar src={team.imageUrl} label={team.name} size={40} />
      <span className={styles.teamNameBlock}>
        <span className={styles.teamName}>
          {team.name} {flagEmoji(team.location)}
        </span>
        {team.acronym && <span className={styles.teamTag}>{team.acronym}</span>}
      </span>
    </span>
  );
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
        <TeamHeader team={match.teamA} side="A" />
        <div className={styles.center}>
          {match.bestOf && <span className={styles.bestOf}>BO{match.bestOf}</span>}
          <span className={styles.bigScore}>
            {finished || running ? `${match.scoreA ?? 0} vs ${match.scoreB ?? 0}` : 'vs'}
          </span>
          <span className={styles.when}>
            {running ? (
              <span className={styles.live}>● live</span>
            ) : finished ? (
              'Terminé'
            ) : (
              formatKickoff(match.scheduledAt)
            )}
          </span>
        </div>
        <TeamHeader team={match.teamB} side="B" />
      </div>

      {games.length > 0 && (
        <ul className={styles.games}>
          {games.map((game) => (
            <li key={game.position} className={styles.game}>
              M{game.position} : {game.winner === 'A' ? tagA : game.winner === 'B' ? tagB : '·'}
            </li>
          ))}
        </ul>
      )}

      {match.streamUrl && !finished && (
        <a className={styles.stream} href={match.streamUrl} target="_blank" rel="noreferrer">
          Regarder le stream
        </a>
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
                          <td className={styles.playerCell}>
                            <Avatar
                              src={player?.imageUrl}
                              fallbackSrc={player?.team?.imageUrl}
                              label={player?.name ?? '?'}
                              size={24}
                            />
                            {player?.name ?? 'Inconnu'} {flagEmoji(player?.nationality)}
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
