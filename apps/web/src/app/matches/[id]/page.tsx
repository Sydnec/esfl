'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GAME_LABELS } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { request } from '@/lib/api';
import { flagEmoji } from '@/lib/flags';
import { agentIconSrc } from '@/lib/agents';
import { formatDateTime, formatKickoff } from '@/lib/format';
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
  /** Manche affichée dans les tableaux de perfs (null = cumul du match). */
  const [selectedMap, setSelectedMap] = useState<number | null>(null);
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

  // Manches disposant d'un détail joueur (onglets M1, M2… de la section perfs).
  const mapTabs = useMemo(() => {
    const byPosition = new Map<number, string | null>();
    for (const line of stats) {
      for (const entry of line.perMap ?? []) {
        if (!byPosition.has(entry.position)) byPosition.set(entry.position, entry.map);
      }
    }
    return [...byPosition.entries()]
      .map(([position, map]) => ({ position, map }))
      .sort((a, b) => a.position - b.position);
  }, [stats]);

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
        {GAME_LABELS[match.gameId]} ·{' '}
        <Link className={styles.competitionLink} href={`/competitions/${match.competition.id}`}>
          {match.competition.name}
        </Link>
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
              {finished
                ? `Terminé · ${formatDateTime(match.scheduledAt)}`
                : running
                  ? 'En cours'
                  : formatKickoff(match.scheduledAt)}
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

      {/* Manches et filtre des perfs fusionnés : le score vit dans le bouton,
          cliquable quand le détail par map existe. */}
      {games.length > 0 && (
        <div className={styles.mapChips}>
          {mapTabs.length > 0 && (
            <button
              className={`${styles.mapChip} ${selectedMap === null ? styles.mapChipActive : ''}`}
              onClick={() => setSelectedMap(null)}
            >
              Cumulé
            </button>
          )}
          {games.map((game) => {
            // Pas de choix de map en LoL : on parle de « Game N ».
            const label =
              game.map ?? (match.gameId === 'lol' ? `Game ${game.position}` : `M${game.position}`);
            const score =
              game.scoreA != null && game.scoreB != null
                ? `${game.scoreA}-${game.scoreB}${match.gameId === 'lol' ? ' kills' : ''}`
                : game.winner
                  ? `victoire ${game.winner === 'A' ? tagA : tagB}`
                  : 'en cours';
            const clickable = mapTabs.some((tab) => tab.position === game.position);
            const content = (
              <>
                {label} <span className={styles.mapChipScore}>{score}</span>
              </>
            );
            return clickable ? (
              <button
                key={game.position}
                className={`${styles.mapChip} ${selectedMap === game.position ? styles.mapChipActive : ''}`}
                title={formatLength(game.lengthSec)}
                onClick={() => setSelectedMap(game.position)}
              >
                {content}
              </button>
            ) : (
              <span key={game.position} className={styles.mapChip} title={formatLength(game.lengthSec)}>
                {content}
              </span>
            );
          })}
        </div>
      )}

      {finished && stats.length > 0 && (
        <section className={styles.statsSection}>
          <h2 className={styles.statsTitle}>Performances</h2>
          {[match.teamA, match.teamB].map((team) => {
            const lines = statsByTeam(team?.id);
            if (!team || lines.length === 0) return null;
            const columns = STAT_COLUMNS[match.gameId];
            const cumulative = selectedMap === null;
            const withAgents = mapTabs.length > 0;
            return (
              <div key={team.id} className={styles.teamStats}>
                <h3 className={styles.teamStatsTitle}>
                  {team.name} {flagEmoji(team.location)}
                </h3>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Joueur</th>
                      {withAgents && <th>{cumulative ? 'Agents' : 'Agent'}</th>}
                      {columns.map((column) => (
                        <th key={column.key}>{column.label}</th>
                      ))}
                      {cumulative && <th>Pts fantasy</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const player = players.get(line.playerId);
                      const mapEntry = cumulative
                        ? null
                        : (line.perMap ?? []).find((entry) => entry.position === selectedMap);
                      if (!cumulative && !mapEntry) return null;
                      const values = (mapEntry ?? line.normalized) as Record<
                        string,
                        number | boolean | null
                      >;
                      // Agents joués : dédupliqués sur la vue cumulée, celui
                      // de la manche sinon.
                      const agents = [
                        ...new Map(
                          (cumulative ? (line.perMap ?? []) : [mapEntry!])
                            .filter((entry) => entry.agent || entry.agentImage)
                            .map((entry) => [entry.agent ?? entry.agentImage, entry]),
                        ).values(),
                      ];
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
                          {withAgents && (
                            <td className={styles.agentCell}>
                              {agents.length === 0
                                ? '·'
                                : agents.map((entry) => {
                                    const src = agentIconSrc(match.gameId, entry);
                                    return src ? (
                                      <img
                                        key={entry.agent ?? src}
                                        className={styles.agentIcon}
                                        src={src}
                                        alt={entry.agent ?? 'agent'}
                                        title={entry.agent ?? undefined}
                                        onError={(event) => {
                                          // Icône locale absente (nouvel agent).
                                          event.currentTarget.style.display = 'none';
                                        }}
                                      />
                                    ) : (
                                      <span key={entry.agent}>{entry.agent}</span>
                                    );
                                  })}
                            </td>
                          )}
                          {columns.map((column) => (
                            <td key={column.key}>{formatStat(values[column.key])}</td>
                          ))}
                          {cumulative && (
                            <td className={styles.points}>{points.get(line.playerId) ?? '·'}</td>
                          )}
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
