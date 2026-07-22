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

/** Équipe avec son effectif et ses compétitions engagées (page détail équipe). */
export interface TeamDetail extends TeamRef {
  gameId: GameId;
  /** Effectif titulaire : les fiches portent déjà l'équipe, inutile de l'imbriquer. */
  players: Array<Omit<PlayerRef, 'team'>>;
  competitions: Competition[];
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
  /** Début réel du match (durée écoulée de la game en cours). */
  beginAt?: string | null;
  name: string;
  scoreA: number | null;
  scoreB: number | null;
  teamA: TeamRef | null;
  teamB: TeamRef | null;
  winnerTeamId?: string | null;
  /** Gagné par forfait (adversaire absent) : pas de stats, vainqueur défini. */
  forfeit?: boolean;
  /** Tournoi (phase) du match : poule/playoffs, pour l'affichage arbre/poules. */
  tournamentId?: number | null;
  tournamentName?: string | null;
  competition: { id: string; name: string; gameId: GameId };
  bestOf?: number | null;
  streamUrl?: string | null;
  gamesSummary?: GameSummaryEntry[] | null;
  /** Page de stats chez le provider : chemin VLR, URL wiki Leaguepedia,
   * ou id de match bo3 (non cliquable). */
  statsPageUrl?: string | null;
  /** Snapshot de l'équipe au moment des stats (nom/tag figés, pas de logo). */
  teamASnapshot?: TeamSnapshot | null;
  teamBSnapshot?: TeamSnapshot | null;
}

export interface TeamSnapshot {
  name: string;
  acronym: string | null;
}

export interface MatchStatsLine {
  playerId: string;
  gameId: GameId;
  source: string;
  normalized: Record<string, number | boolean | null>;
  /** Détail par manche (agent, KDA par map) quand la source le fournit. */
  perMap?: MapStatsEntry[] | null;
  /** Snapshot au moment du match : pseudo publié par la source. */
  playerName?: string | null;
  /** Snapshot : rôle joué sur CE match (LoL). */
  role?: string | null;
  /** Snapshot : côté du joueur, survit aux transferts. */
  teamSide?: 'A' | 'B' | null;
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
