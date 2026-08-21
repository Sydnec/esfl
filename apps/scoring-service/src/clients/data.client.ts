import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface DataMatch {
  id: string;
  name: string;
  gameId: string;
  competitionId: string;
  status: string;
  scheduledAt: string | null;
  beginAt: string | null;
  endAt: string | null;
  scoreA: number | null;
  scoreB: number | null;
  /** Manches : scoreA/scoreB par map = base des rounds (CS2/Valorant). */
  gamesSummary: Array<{
    position: number;
    winner: 'A' | 'B' | null;
    scoreA?: number | null;
    scoreB?: number | null;
  }> | null;
  /** Objectifs neutres LoL par côté (dragons+barons+hérauts), pour le bonus Jungler. */
  teamObjectives?: { A: number; B: number } | null;
}

export interface DataPlayerMatchStats {
  id: string;
  matchId: string;
  playerId: string;
  gameId: string;
  source: string;
  normalized: unknown;
  role: string | null;
  /** Côté A/B du joueur (bonus Jungler LoL). */
  teamSide: 'A' | 'B' | null;
}

/** Ligne de stats pour le calcul des distributions de scoring. */
export interface DataScoringStat {
  playerId: string;
  matchId: string;
  role: string | null;
  normalized: unknown;
  maps: number;
}

export interface DataPlayerMeta {
  id: string;
  name: string;
  gameId: string;
  role: string | null;
  team: { name: string; acronym: string | null } | null;
}

/** Complétude des stats d'une journée Paris (base du gel des scores). */
export interface DayCompleteness {
  date: string;
  totalMatches: number;
  pendingCount: number;
  missingCount: number;
  /** Matchs finis avec des stats présentes mais incohérentes (bloquent le gel). */
  incoherentCount: number;
  complete: boolean;
  /** Matchs finis avec stats : à re-noter une dernière fois avant le gel. */
  scoredMatchIds: string[];
  /** Joueurs dont un match du jour n'a aucune stat : écartés de la moyenne. */
  uncoveredPlayerIds: string[];
}

/** Client REST interne vers le data-service. */
@Injectable()
export class DataClient {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('DATA_SERVICE_URL') ?? 'http://localhost:4002';
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new ServiceUnavailableException(`data-service ${path} → ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async getMatch(id: string): Promise<DataMatch> {
    const match = await this.get<DataMatch | null>(`/data/matches/${id}`);
    if (!match) {
      throw new NotFoundException(`Match inconnu : ${id}`);
    }
    return match;
  }

  listMatches(competitionIds: string[], from: Date, to: Date): Promise<DataMatch[]> {
    return this.get<DataMatch[]>('/data/matches', {
      competitionIds: competitionIds.join(','),
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }

  listStats(matchIds: string[]): Promise<DataPlayerMatchStats[]> {
    return this.get<DataPlayerMatchStats[]>('/data/stats', { matchIds: matchIds.join(',') });
  }

  /**
   * Ids des matchs ayant des stats (pour le recalcul en masse). `since` borne
   * aux matchs terminés depuis cette date — le rattrapage des notes manquantes
   * n'a pas besoin de tout l'historique.
   */
  listStatsMatchIds(since?: Date): Promise<string[]> {
    return this.get<string[]>(
      '/data/internal/stats/match-ids',
      since ? { since: since.toISOString() } : {},
    );
  }

  /** Métadonnées de tous les joueurs (pour l'analytics de points). */
  getPlayerMeta(): Promise<DataPlayerMeta[]> {
    return this.get<DataPlayerMeta[]>('/data/internal/players/meta');
  }

  /** Toutes les stats d'un jeu (matchs finis) pour le calcul des distributions. */
  getScoringStats(gameId: string): Promise<DataScoringStat[]> {
    return this.get<DataScoringStat[]>('/data/internal/stats/all', { gameId });
  }

  /** Complétude des stats d'une journée Paris (gel des scores). */
  /**
   * `avecNonCouverts` déclenche côté data une requête supplémentaire : à ne
   * demander que pour noter les rosters, pas pour décider d'un gel.
   */
  dayCompleteness(date: string, avecNonCouverts = false): Promise<DayCompleteness> {
    const suffixe = avecNonCouverts ? '?uncovered=true' : '';
    return this.get<DayCompleteness>(`/data/internal/days/${date}/completeness${suffixe}`);
  }
}
