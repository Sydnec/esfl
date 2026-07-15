'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { GAME_SHORT_LABELS } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { Avatar } from '@/components/Avatar';
import { MatchGrid } from '@/components/MatchCard';
import { API_URL, ApiError, request } from '@/lib/api';
import { formatDateTime, formatDayChip, parisDateOf } from '@/lib/format';
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

const MEDALS = ['🥇', '🥈', '🥉'];

interface TopPerf {
  points: number;
  player: PlayerRef | null;
}

/** Date calendaire Europe/Paris du jour (YYYY-MM-DD). */
function todayParis(): string {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

/** Repère relatif lisible : « Aujourd'hui », « Demain », « Dans 3 jours »… */
function relativeDay(date: string): string {
  const diff = Math.round(
    (new Date(`${date}T12:00:00`).getTime() - new Date(`${todayParis()}T12:00:00`).getTime()) /
      86_400_000,
  );
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Demain';
  if (diff === -1) return 'Hier';
  if (diff > 0) return `Dans ${diff} jours`;
  return `Il y a ${-diff} jours`;
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
  const [editName, setEditName] = useState('');
  const [editRosterSize, setEditRosterSize] = useState(5);
  const [editLockDays, setEditLockDays] = useState(2);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    setSettingsError(null);
    try {
      await authedFetch(`/fantasy/leagues/${id}/competitions`, {
        method: 'POST',
        body: JSON.stringify({ competitionId: addCompetitionId }),
      });
      setAddCompetitionId('');
      await load();
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : 'Ajout impossible');
    }
  }

  function openSettings() {
    if (league) {
      setEditName(league.name);
      setEditRosterSize(league.rosterSize);
      setEditLockDays(league.lockMatchDays);
    }
    setSettingsError(null);
    setSettingsOpen(true);
  }

  async function handleSaveSettings(event: React.FormEvent) {
    event.preventDefault();
    setSettingsError(null);
    try {
      await authedFetch(`/fantasy/leagues/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          rosterSize: editRosterSize,
          lockMatchDays: editLockDays,
        }),
      });
      await load();
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : 'Enregistrement impossible');
    }
  }

  async function handleRemoveCompetition(competitionId: string) {
    setSettingsError(null);
    try {
      await authedFetch(`/fantasy/leagues/${id}/competitions/${competitionId}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : 'Retrait impossible');
    }
  }

  async function handleKick(userId: string) {
    const ref = members.get(userId);
    if (!window.confirm(`Exclure ${ref?.username ?? 'ce membre'} de la ligue ?`)) return;
    setError(null);
    try {
      await authedFetch(`/fantasy/leagues/${id}/members/${userId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Exclusion impossible');
    }
  }

  async function handleLeave() {
    if (!user) return;
    const warning = isOwner
      ? 'Quitter la ligue ? Elle sera transférée au plus ancien membre (ou supprimée si tu es seul).'
      : 'Quitter la ligue ? Tes rosters et tes points y seront supprimés.';
    if (!window.confirm(warning)) return;
    setSettingsError(null);
    try {
      await authedFetch(`/fantasy/leagues/${id}/members/${user.id}`, { method: 'DELETE' });
      router.replace('/dashboard');
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : 'Départ impossible');
    }
  }

  async function handleDeleteLeague() {
    if (!window.confirm('Supprimer définitivement la ligue, ses journées et ses scores ?')) return;
    setSettingsError(null);
    try {
      await authedFetch(`/fantasy/leagues/${id}`, { method: 'DELETE' });
      router.replace('/dashboard');
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : 'Suppression impossible');
    }
  }

  function copyInvite() {
    if (!league) return;
    navigator.clipboard
      ?.writeText(league.inviteCode)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  if (loading || !user || !league) {
    return <main className={styles.main}>{error ?? 'Chargement…'}</main>;
  }

  const isOwner = league.ownerId === user.id;
  const memberCount = league.members?.length ?? league._count?.members ?? 0;
  const myEntry = leaderboard.find((entry) => entry.userId === user.id) ?? null;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <h1 className={styles.title}>{league.name}</h1>
          <button className={styles.settingsButton} onClick={openSettings}>
            ⚙ Paramètres
          </button>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Membres</span>
            <span className={styles.statValue}>{memberCount}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Roster</span>
            <span className={styles.statValue}>{league.rosterSize}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Verrou</span>
            <span className={styles.statValue}>{league.lockMatchDays} j</span>
          </div>
          <div className={`${styles.stat} ${styles.statAccent}`}>
            <span className={styles.statLabel}>Ton rang</span>
            <span className={styles.statValue}>
              {myEntry ? `${myEntry.rank}e · ${myEntry.points} pts` : '—'}
            </span>
          </div>
          <button className={styles.copyBtn} onClick={copyInvite} title="Copier le code d’invitation">
            <span className={styles.copyCode}>{league.inviteCode}</span>
            <span className={styles.copyHint}>{copied ? 'copié ✓' : 'copier'}</span>
          </button>
        </div>
      </header>
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
            {settingsError && <p className={styles.error}>{settingsError}</p>}
            <dl className={styles.settingsList}>
              <dt>Code d&apos;invitation</dt>
              <dd>
                <strong>{league.inviteCode}</strong>
              </dd>
              {!isOwner && (
                <>
                  <dt>Joueurs par roster</dt>
                  <dd>{league.rosterSize}</dd>
                  <dt>Verrouillage après un pick</dt>
                  <dd>{league.lockMatchDays} journée(s)</dd>
                </>
              )}
            </dl>
            {isOwner && (
              <form className={styles.settingsForm} onSubmit={handleSaveSettings}>
                <label className={styles.settingsField}>
                  Nom de la ligue
                  <input
                    className={styles.input}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    minLength={3}
                    maxLength={40}
                    required
                  />
                </label>
                <div className={styles.settingsRow}>
                  <label className={styles.settingsField}>
                    Joueurs par roster
                    <input
                      className={styles.input}
                      type="number"
                      min={1}
                      max={10}
                      value={editRosterSize}
                      onChange={(e) => setEditRosterSize(Number(e.target.value))}
                      required
                    />
                  </label>
                  <label className={styles.settingsField}>
                    Verrouillage (journées)
                    <input
                      className={styles.input}
                      type="number"
                      min={0}
                      max={10}
                      value={editLockDays}
                      onChange={(e) => setEditLockDays(Number(e.target.value))}
                      required
                    />
                  </label>
                </div>
                <button className={styles.addButton} type="submit">
                  Enregistrer
                </button>
              </form>
            )}
            <h3 className={styles.modalSubtitle}>Compétitions suivies</h3>
            <ul className={styles.competitions}>
              {league.competitions.map((entry) => (
                <li key={entry.competitionId} className={styles.competitionRow}>
                  <Link
                    className={styles.competitionModalLink}
                    href={`/competitions/${entry.competitionId}`}
                  >
                    {competitionName(entry.competitionId)}
                  </Link>
                  {isOwner && league.competitions.length > 1 && (
                    <button
                      className={styles.removeButton}
                      onClick={() => void handleRemoveCompetition(entry.competitionId)}
                    >
                      Retirer
                    </button>
                  )}
                </li>
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
            <h3 className={styles.modalSubtitle}>Zone sensible</h3>
            <div className={styles.dangerZone}>
              <button className={styles.dangerButton} onClick={() => void handleLeave()}>
                Quitter la ligue
              </button>
              {isOwner && (
                <button className={styles.dangerButton} onClick={() => void handleDeleteLeague()}>
                  Supprimer la ligue
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Timeline des journées, en tête. */}
      <section className={styles.timelineSection}>
        <h2 className={styles.sectionTitle}>Journées</h2>
        {matchDays.length === 0 ? (
          <p className={styles.empty}>Aucune journée sur les compétitions suivies pour le moment.</p>
        ) : (
          <div className={styles.timeline}>
            {matchDays.map((day) => {
              const today = day.date === todayParis();
              const active = day.id === selectedDayId;
              return (
                <button
                  key={day.id}
                  className={`${styles.dayChip} ${active ? styles.dayChipActive : ''} ${
                    !active && today ? styles.dayChipToday : ''
                  } ${!active && !today && day.deadlinePassed ? styles.dayChipPast : ''}`}
                  onClick={() => setSelectedDayId(day.id)}
                >
                  {formatDayChip(day.date)}
                  {day.myRosterSubmitted && <span className={styles.daySubmitted}>✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className={styles.grid}>
        {/* Colonne principale : la journée sélectionnée (celle du jour par défaut). */}
        <section className={styles.card}>
          {selectedDay ? (
            <>
              <div className={styles.dayHead}>
                <div className={styles.dayWhen}>
                  <span className={styles.dayWhenMain}>{relativeDay(selectedDay.date)}</span>
                  <span
                    className={`${styles.dayWhenSub} ${
                      !selectedDay.deadlinePassed ? styles.dayWhenSubDue : ''
                    }`}
                  >
                    {formatDayChip(selectedDay.date)}
                    {' · '}
                    {selectedDay.deadlinePassed
                      ? 'picks verrouillés'
                      : `clôture ${formatDateTime(selectedDay.firstMatchAt)}`}
                  </span>
                </div>
                <Link
                  href={`/leagues/${league.id}/days/${selectedDay.id}`}
                  className={selectedDay.deadlinePassed ? styles.dayCtaMuted : styles.dayCta}
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
            </>
          ) : (
            <p className={styles.empty}>Sélectionne une journée ci-dessus.</p>
          )}
        </section>

        {/* Colonne latérale : classement + meilleures perfs. */}
        <aside className={styles.side}>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Classement</h2>
            {leaderboard.length === 0 ? (
              <p className={styles.empty}>Aucun point marqué pour l&apos;instant.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.rankCell}>#</th>
                    <th>Joueur</th>
                    <th className={styles.numHead}>Pts</th>
                    <th className={styles.numHead}>J.</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((entry) => {
                    const member = members.get(entry.userId);
                    return (
                      <tr key={entry.userId} className={entry.userId === user.id ? styles.me : ''}>
                        <td className={styles.rankCell}>
                          {entry.rank <= 3 ? (
                            <span className={styles.medal}>{MEDALS[entry.rank - 1]}</span>
                          ) : (
                            entry.rank
                          )}
                        </td>
                        <td>
                          <span className={styles.memberCell}>
                            <Avatar
                              src={member?.avatarUrl ? `${API_URL}${member.avatarUrl}` : null}
                              label={member?.username ?? '?'}
                              size={22}
                              fit="cover"
                            />
                            <span>{member?.username ?? 'Ancien membre'}</span>
                          </span>
                        </td>
                        <td className={`${styles.num} ${styles.pointsCell}`}>{entry.points}</td>
                        <td className={styles.num}>{entry.matchDaysPlayed}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {topPerfsDate && (
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Meilleures perfs · {topPerfsDate}</h2>
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
                        fit="cover"
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
            </section>
          )}
        </aside>
      </div>

      {/* Membres, pleine largeur. */}
      <section className={styles.membersSection}>
        <h2 className={styles.sectionTitle}>Membres ({memberCount})</h2>
        <ul className={styles.members}>
          {(league.members ?? []).map((member) => {
            const ref = members.get(member.userId);
            return (
              <li key={member.userId} className={styles.member}>
                <Avatar
                  src={ref?.avatarUrl ? `${API_URL}${ref.avatarUrl}` : null}
                  label={ref?.username ?? '?'}
                  size={24}
                  fit="cover"
                />
                <span className={styles.memberName}>{ref?.username ?? 'Ancien membre'}</span>
                {member.role === 'owner' && <span className={styles.ownerTag}>créateur</span>}
                {isOwner && member.userId !== user.id && (
                  <button
                    className={styles.kickButton}
                    onClick={() => void handleKick(member.userId)}
                  >
                    Exclure
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
