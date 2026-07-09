'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { GAME_LABELS } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { ApiError, request } from '@/lib/api';
import type {
  Competition,
  LeaderboardEntry,
  League,
  MatchDaySummary,
  MatchSummary,
  PublicUserRef,
} from '@/lib/types';
import styles from './page.module.css';

export default function LeaguePage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading, authedFetch } = useAuth();
  const router = useRouter();

  const [league, setLeague] = useState<League | null>(null);
  const [matchDays, setMatchDays] = useState<MatchDaySummary[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [catalog, setCatalog] = useState<Competition[]>([]);
  const [usernames, setUsernames] = useState<Map<string, string>>(new Map());
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [addCompetitionId, setAddCompetitionId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const detail = await authedFetch<League>(`/fantasy/leagues/${id}`);
      setLeague(detail);
      const competitionIds = detail.competitions.map((entry) => entry.competitionId).join(',');
      const [days, board, allCompetitions, members, planning] = await Promise.all([
        authedFetch<MatchDaySummary[]>(`/fantasy/leagues/${id}/matchdays`),
        authedFetch<LeaderboardEntry[]>(`/scoring/leagues/${id}/leaderboard`),
        request<Competition[]>('/data/competitions'),
        request<PublicUserRef[]>(
          `/auth/users?ids=${(detail.members ?? []).map((member) => member.userId).join(',')}`,
        ),
        request<MatchSummary[]>(
          `/data/matches?competitionIds=${competitionIds}&from=${new Date(Date.now() - 24 * 3600 * 1000).toISOString()}`,
        ),
      ]);
      setMatchDays(days);
      setLeaderboard(board);
      setCatalog(allCompetitions);
      setUsernames(new Map(members.map((member) => [member.id, member.username])));
      setMatches(planning.slice(0, 20));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Chargement impossible');
    }
  }, [id, authedFetch]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const followedIds = useMemo(
    () => new Set(league?.competitions.map((entry) => entry.competitionId)),
    [league],
  );
  const competitionName = useCallback(
    (competitionId: string) => catalog.find((c) => c.id === competitionId)?.name ?? competitionId,
    [catalog],
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
  const upcomingDays = matchDays.filter((day) => !day.deadlinePassed);
  const pastDays = matchDays.filter((day) => day.deadlinePassed);

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>{league.name}</h1>
        <span className={styles.invite}>
          Code d’invitation : <strong>{league.inviteCode}</strong>
        </span>
      </div>
      <p className={styles.settings}>
        Roster de {league.rosterSize} joueurs · verrouillage {league.lockMatchDays} journée(s)
      </p>
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.columns}>
        <section className={styles.column}>
          <h2 className={styles.sectionTitle}>Classement</h2>
          {leaderboard.length === 0 ? (
            <p className={styles.empty}>Aucun point marqué pour l’instant.</p>
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
                {leaderboard.map((entry) => (
                  <tr key={entry.userId} className={entry.userId === user.id ? styles.me : ''}>
                    <td>{entry.rank}</td>
                    <td>{usernames.get(entry.userId) ?? entry.userId}</td>
                    <td>{entry.points}</td>
                    <td>{entry.matchDaysPlayed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 className={styles.sectionTitle}>Membres ({league.members?.length ?? 0})</h2>
          <ul className={styles.members}>
            {(league.members ?? []).map((member) => (
              <li key={member.userId}>
                {usernames.get(member.userId) ?? member.userId}
                {member.role === 'owner' && <span className={styles.ownerTag}> · créateur</span>}
              </li>
            ))}
          </ul>

          <h2 className={styles.sectionTitle}>Compétitions suivies</h2>
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
                    [{GAME_LABELS[competition.gameId]}] {competition.name}
                  </option>
                ))}
              </select>
              <button className={styles.addButton} type="submit" disabled={!addCompetitionId}>
                Ajouter
              </button>
            </form>
          )}
        </section>

        <section className={styles.column}>
          <h2 className={styles.sectionTitle}>Journées à venir</h2>
          {upcomingDays.length === 0 ? (
            <p className={styles.empty}>Aucune journée à venir sur les compétitions suivies.</p>
          ) : (
            <ul className={styles.days}>
              {upcomingDays.map((day) => (
                <li key={day.id}>
                  <Link href={`/leagues/${league.id}/days/${day.id}`} className={styles.day}>
                    <span>{day.date}</span>
                    <span className={styles.dayMeta}>
                      deadline {new Date(day.firstMatchAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                      {day.myRosterSubmitted ? ' · roster soumis ✓' : ' · roster à faire'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {pastDays.length > 0 && (
            <>
              <h2 className={styles.sectionTitle}>Journées passées</h2>
              <ul className={styles.days}>
                {pastDays.slice(-5).map((day) => (
                  <li key={day.id}>
                    <Link href={`/leagues/${league.id}/days/${day.id}`} className={styles.day}>
                      <span>{day.date}</span>
                      <span className={styles.dayMeta}>
                        {day.myRosterSubmitted ? 'roster soumis' : 'non joué'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2 className={styles.sectionTitle}>Planning des matchs</h2>
          {matches.length === 0 ? (
            <p className={styles.empty}>Aucun match à venir.</p>
          ) : (
            <ul className={styles.matches}>
              {matches.map((match) => (
                <li key={match.id} className={styles.match}>
                  <span className={styles.matchGame}>{GAME_LABELS[match.gameId]}</span>
                  <span title={`${match.teamA?.name ?? '?'} vs ${match.teamB?.name ?? '?'}`}>
                    {match.teamA?.acronym || match.teamA?.name || '?'} vs{' '}
                    {match.teamB?.acronym || match.teamB?.name || '?'}
                    {match.status === 'finished' && ` — ${match.scoreA} : ${match.scoreB}`}
                  </span>
                  <span className={styles.matchDate}>
                    {match.scheduledAt
                      ? new Date(match.scheduledAt).toLocaleString('fr-FR', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
