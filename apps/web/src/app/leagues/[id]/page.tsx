'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { GAME_SHORT_LABELS } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { Avatar } from '@/components/Avatar';
import { MatchGrid } from '@/components/MatchCard';
import { API_URL, ApiError, request } from '@/lib/api';
import { formatDayChip, parisDateOf } from '@/lib/format';
import type {
  Competition,
  LeaderboardEntry,
  League,
  MatchDaySummary,
  MatchSummary,
  PlayerRef,
  PublicUserRef,
  TopPlayerEntry,
} from '@/lib/types';
import styles from './page.module.css';

const DAY_POLL_INTERVAL_MS = 60_000;

interface TopPerf {
  points: number;
  player: PlayerRef | null;
}

export default function LeaguePage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading, authedFetch } = useAuth();
  const router = useRouter();

  const [league, setLeague] = useState<League | null>(null);
  const [matchDays, setMatchDays] = useState<MatchDaySummary[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [catalog, setCatalog] = useState<Competition[]>([]);
  const [members, setMembers] = useState<Map<string, PublicUserRef>>(new Map());
  const [topPerfs, setTopPerfs] = useState<TopPerf[]>([]);
  const [topPerfsDate, setTopPerfsDate] = useState<string | null>(null);
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);
  const [dayMatches, setDayMatches] = useState<MatchSummary[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addCompetitionId, setAddCompetitionId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const detail = await authedFetch<League>(`/fantasy/leagues/${id}`);
      setLeague(detail);
      const [days, board, allCompetitions, memberRefs] = await Promise.all([
        authedFetch<MatchDaySummary[]>(`/fantasy/leagues/${id}/matchdays`),
        authedFetch<LeaderboardEntry[]>(`/scoring/leagues/${id}/leaderboard`),
        request<Competition[]>('/data/competitions'),
        request<PublicUserRef[]>(
          `/auth/users?ids=${(detail.members ?? []).map((member) => member.userId).join(',')}`,
        ),
      ]);
      setMatchDays(days);
      setLeaderboard(board);
      setCatalog(allCompetitions);
      setMembers(new Map(memberRefs.map((member) => [member.id, member])));
      setSelectedDayId(
        (current) =>
          current ?? (days.find((day) => !day.deadlinePassed) ?? days.at(-1))?.id ?? null,
      );

      const lastPassed = days.filter((day) => day.deadlinePassed).at(-1);
      if (lastPassed) {
        setTopPerfsDate(lastPassed.date);
        const top = await authedFetch<TopPlayerEntry[]>(
          `/scoring/leagues/${id}/days/${lastPassed.date}/top-players`,
        );
        if (top.length > 0) {
          const players = await request<PlayerRef[]>(
            `/data/players/by-ids?ids=${top.map((entry) => entry.playerId).join(',')}`,
          );
          const byId = new Map(players.map((player) => [player.id, player]));
          setTopPerfs(
            top.map((entry) => ({ points: entry.points, player: byId.get(entry.playerId) ?? null })),
          );
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Chargement impossible');
    }
  }, [id, authedFetch]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const selectedDay = useMemo(
    () => matchDays.find((day) => day.id === selectedDayId) ?? null,
    [matchDays, selectedDayId],
  );

  // Matchs de la journée sélectionnée, rafraîchis périodiquement.
  const loadDayMatches = useCallback(async () => {
    if (!league || !selectedDay) return;
    const competitionIds = league.competitions.map((entry) => entry.competitionId).join(',');
    const dayStart = new Date(`${selectedDay.date}T00:00:00Z`);
    const from = new Date(dayStart.getTime() - 12 * 3600 * 1000).toISOString();
    const to = new Date(dayStart.getTime() + 36 * 3600 * 1000).toISOString();
    const matches = await request<MatchSummary[]>(
      `/data/matches?competitionIds=${competitionIds}&from=${from}&to=${to}`,
    );
    setDayMatches(
      matches.filter((match) => {
        const start = match.scheduledAt;
        return start && parisDateOf(start) === selectedDay.date;
      }),
    );
  }, [league, selectedDay]);

  useEffect(() => {
    setDayMatches(null);
    void loadDayMatches();
    const interval = setInterval(() => {
      if (!document.hidden) void loadDayMatches();
    }, DAY_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadDayMatches]);

  const competitionName = useCallback(
    (competitionId: string) => catalog.find((c) => c.id === competitionId)?.name ?? competitionId,
    [catalog],
  );
  const followedIds = useMemo(
    () => new Set(league?.competitions.map((entry) => entry.competitionId)),
    [league],
  );
  const addable = useMemo(
    () => catalog.filter((competition) => !followedIds.has(competition.id)),
    [catalog, followedIds],
  );

  async function handleAddCompetition(event: React.FormEvent) {
    event.preventDefault();
    if (!addCompetitionId) return;
    setError(null);
    try {
      await authedFetch(`/fantasy/leagues/${id}/competitions`, {
        method: 'POST',
        body: JSON.stringify({ competitionId: addCompetitionId }),
      });
      setAddCompetitionId('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ajout impossible');
    }
  }

  if (loading || !user || !league) {
    return <main className={styles.main}>{error ?? 'Chargement…'}</main>;
  }

  const isOwner = league.ownerId === user.id;

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>{league.name}</h1>
        <button className={styles.settingsButton} onClick={() => setSettingsOpen(true)}>
          Paramètres
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}

      {settingsOpen && (
        <div className={styles.overlay} onClick={() => setSettingsOpen(false)}>
          <div
            className={styles.modal}
            role="dialog"
            aria-label="Paramètres de la ligue"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>Paramètres</h2>
              <button className={styles.closeButton} onClick={() => setSettingsOpen(false)}>
                Fermer
              </button>
            </div>
            <dl className={styles.settingsList}>
              <dt>Code d&apos;invitation</dt>
              <dd>
                <strong>{league.inviteCode}</strong>
              </dd>
              <dt>Joueurs par roster</dt>
              <dd>{league.rosterSize}</dd>
              <dt>Verrouillage après un pick</dt>
              <dd>{league.lockMatchDays} journée(s)</dd>
            </dl>
            <h3 className={styles.modalSubtitle}>Compétitions suivies</h3>
            <ul className={styles.competitions}>
              {league.competitions.map((entry) => (
                <li key={entry.competitionId}>{competitionName(entry.competitionId)}</li>
              ))}
            </ul>
            {isOwner && addable.length > 0 && (
              <form className={styles.addForm} onSubmit={handleAddCompetition}>
                <select
                  className={styles.select}
                  value={addCompetitionId}
                  onChange={(e) => setAddCompetitionId(e.target.value)}
                >
                  <option value="">Ajouter une compétition…</option>
                  {addable.map((competition) => (
                    <option key={competition.id} value={competition.id}>
                      [{GAME_SHORT_LABELS[competition.gameId]}] {competition.name}
                    </option>
                  ))}
                </select>
                <button className={styles.addButton} type="submit" disabled={!addCompetitionId}>
                  Ajouter
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      <div className={styles.columns}>
        <section className={styles.column}>
          <h2 className={styles.sectionTitle}>Classement</h2>
          {leaderboard.length === 0 ? (
            <p className={styles.empty}>Aucun point marqué pour l&apos;instant.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Joueur</th>
                  <th>Points</th>
                  <th>Journées</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((entry) => {
                  const member = members.get(entry.userId);
                  return (
                    <tr key={entry.userId} className={entry.userId === user.id ? styles.me : ''}>
                      <td>{entry.rank}</td>
                      <td className={styles.memberCell}>
                        <Avatar
                          src={member?.avatarUrl ? `${API_URL}${member.avatarUrl}` : null}
                          label={member?.username ?? '?'}
                          size={20}
                        />
                        {member?.username ?? 'Ancien membre'}
                      </td>
                      <td>{entry.points}</td>
                      <td>{entry.matchDaysPlayed}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {topPerfsDate && (
            <>
              <h2 className={styles.sectionTitle}>Meilleures perfs · {topPerfsDate}</h2>
              {topPerfs.length === 0 ? (
                <p className={styles.empty}>Pas encore de points calculés sur cette journée.</p>
              ) : (
                <ol className={styles.topPerfs}>
                  {topPerfs.map((perf, index) => (
                    <li key={perf.player?.id ?? index} className={styles.topPerf}>
                      <span className={styles.topRank}>{index + 1}</span>
                      <Avatar
                        src={perf.player?.imageUrl}
                        fallbackSrc={perf.player?.team?.imageUrl}
                        label={perf.player?.name ?? '?'}
                        size={28}
                      />
                      <span className={styles.topName}>
                        {perf.player ? (
                          <Link className={styles.topNameLink} href={`/players/${perf.player.id}`}>
                            {perf.player.name}
                          </Link>
                        ) : (
                          'Joueur inconnu'
                        )}
                        <span className={styles.topTeam}>
                          {' '}
                          {perf.player?.team?.acronym || perf.player?.team?.name || ''}
                        </span>
                      </span>
                      <span className={styles.topPoints}>{perf.points} pts</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}

          <h2 className={styles.sectionTitle}>Membres ({league.members?.length ?? 0})</h2>
          <ul className={styles.members}>
            {(league.members ?? []).map((member) => {
              const ref = members.get(member.userId);
              return (
                <li key={member.userId} className={styles.memberCell}>
                  <Avatar
                    src={ref?.avatarUrl ? `${API_URL}${ref.avatarUrl}` : null}
                    label={ref?.username ?? '?'}
                    size={22}
                  />
                  {ref?.username ?? 'Ancien membre'}
                  {member.role === 'owner' && <span className={styles.ownerTag}> · créateur</span>}
                </li>
              );
            })}
          </ul>
        </section>

        <section className={styles.column}>
          <h2 className={styles.sectionTitle}>Journées</h2>
          {matchDays.length === 0 ? (
            <p className={styles.empty}>
              Aucune journée sur les compétitions suivies pour le moment.
            </p>
          ) : (
            <>
              <div className={styles.timeline}>
                {matchDays.map((day) => (
                  <button
                    key={day.id}
                    className={`${styles.dayChip} ${day.id === selectedDayId ? styles.dayChipActive : ''} ${
                      day.deadlinePassed ? styles.dayChipPast : ''
                    }`}
                    onClick={() => setSelectedDayId(day.id)}
                  >
                    {formatDayChip(day.date)}
                    {day.myRosterSubmitted && <span className={styles.daySubmitted}> ✓</span>}
                  </button>
                ))}
              </div>

              {selectedDay && (
                <div className={styles.dayPanel}>
                  <div className={styles.dayHeader}>
                    <h3 className={styles.dayTitle}>{formatDayChip(selectedDay.date)}</h3>
                    <Link
                      href={`/leagues/${league.id}/days/${selectedDay.id}`}
                      className={selectedDay.deadlinePassed ? styles.dayLinkMuted : styles.dayLink}
                    >
                      {selectedDay.deadlinePassed
                        ? 'Voir mon roster'
                        : selectedDay.myRosterSubmitted
                          ? 'Modifier mon roster'
                          : 'Composer mon roster'}
                    </Link>
                  </div>
                  {dayMatches === null ? (
                    <p className={styles.empty}>Chargement…</p>
                  ) : dayMatches.length === 0 ? (
                    <p className={styles.empty}>Aucun match ce jour-là.</p>
                  ) : (
                    <MatchGrid matches={dayMatches} />
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
