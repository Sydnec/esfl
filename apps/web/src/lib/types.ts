import type { GameId, MapStatsEntry } from '@esfl/contracts';

export interface Competition {
  id: string;
  gameId: GameId;
  name: string;
  tier: string | null;
  beginAt: string | null;
  endAt: string | null;
  imageUrl: string | null;
}

/** Compétition avec ses équipes engagées (page détail compétition). */
export interface CompetitionDetail extends Competition {
  slug: string | null;
  teams: Array<{ competitionId: string; teamId: string; team: TeamRef }>;
}

export interface League {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  rosterSize: number;
  lockMatchDays: number;
  createdAt: string;
  competitions: Array<{ competitionId: string; addedAt: string }>;
  members?: Array<{ userId: string; role: string; joinedAt: string }>;
  _count?: { members: number };
}

export interface MatchDaySummary {
  id: string;
  date: string;
  firstMatchAt: string;
  deadlinePassed: boolean;
  myRosterSubmitted: boolean;
}

export interface TeamRef {
  id: string;
  name: string;
  acronym: string | null;
  imageUrl: string | null;
  /** Code pays ISO2 pour le drapeau. */
  location?: string | null;
}

export interface GameSummaryEntry {
  position: number;
  winner: 'A' | 'B' | null;
  map?: string | null;
  scoreA?: number | null;
  scoreB?: number | null;
  lengthSec?: number | null;
}

export interface BoardPlayer {
  id: string;
  gameId: GameId;
  name: string;
  role: string | null;
  imageUrl: string | null;
  team: TeamRef | null;
  locked: boolean;
  lockedUntil: string | null;
}

export interface PickBoard {
  matchDay: { id: string; date: string; firstMatchAt: string; deadlinePassed: boolean };
  rosterSize: number;
  lockMatchDays: number;
  myPicks: string[];
  players: BoardPlayer[];
  matches: Array<{
    id: string;
    gameId: GameId;
    name: string;
    scheduledAt: string | null;
    teamAId: string | null;
    teamBId: string | null;
  }>;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  points: number;
  matchDaysPlayed: number;
}

export interface MatchSummary {
  id: string;
  gameId: GameId;
  status: string;
  scheduledAt: string | null;
  name: string;
  scoreA: number | null;
  scoreB: number | null;
  teamA: TeamRef | null;
  teamB: TeamRef | null;
  winnerTeamId?: string | null;
  /** Gagné par forfait (adversaire absent) : pas de stats, vainqueur défini. */
  forfeit?: boolean;
  competition: { id: string; name: string; gameId: GameId };
  bestOf?: number | null;
  streamUrl?: string | null;
  gamesSummary?: GameSummaryEntry[] | null;
}

export interface MatchStatsLine {
  playerId: string;
  gameId: GameId;
  source: string;
  normalized: Record<string, number | boolean | null>;
  /** Détail par manche (agent, KDA par map) quand la source le fournit. */
  perMap?: MapStatsEntry[] | null;
}

export interface FantasyPointsLine {
  playerId: string;
  matchId: string;
  points: number;
}

export interface PublicUserRef {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface TopPlayerEntry {
  playerId: string;
  points: number;
}

export interface PlayerRef {
  id: string;
  gameId: GameId;
  name: string;
  role: string | null;
  imageUrl: string | null;
  nationality: string | null;
  team: TeamRef | null;
}

/** Ligne d'historique d'un joueur : ses stats + le match joint (page joueur). */
export interface PlayerMatchHistoryLine {
  id: string;
  matchId: string;
  source: string;
  normalized: Record<string, number | boolean | null>;
  match: MatchSummary;
}
