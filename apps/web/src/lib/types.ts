import type { GameId } from '@esfl/contracts';

export interface Competition {
  id: string;
  gameId: GameId;
  name: string;
  tier: string | null;
  beginAt: string | null;
  endAt: string | null;
  imageUrl: string | null;
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

export interface BoardPlayer {
  id: string;
  gameId: GameId;
  name: string;
  role: string | null;
  imageUrl: string | null;
  team: { id: string; name: string; acronym: string | null } | null;
  locked: boolean;
  lockedUntil: string | null;
}

export interface PickBoard {
  matchDay: { id: string; date: string; firstMatchAt: string; deadlinePassed: boolean };
  rosterSize: number;
  lockMatchDays: number;
  myPicks: string[];
  players: BoardPlayer[];
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
  teamA: { name: string; acronym: string | null } | null;
  teamB: { name: string; acronym: string | null } | null;
  competition: { id: string; name: string; gameId: GameId };
}

export interface PublicUserRef {
  id: string;
  username: string;
}
