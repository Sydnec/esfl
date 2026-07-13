import type { GameId } from '@esfl/contracts';
import type { Match, Player, Prisma, Team } from '../../generated/client';

/** Contexte de rapprochement fourni aux providers : équipes et rosters locaux. */
export interface MatchContext {
  teamA: Team | null;
  teamB: Team | null;
  /** Joueurs locaux des deux équipes (référentiel Pandascore). */
  players: Player[];
}

/**
 * Ligne de stats retournée par un provider : extraction pure, la résolution
 * d'identité (rapprochement ou création de la fiche) vit dans l'ingestion.
 */
export interface ProviderStatLine {
  /** Pseudo publié par la source. */
  externalName: string;
  /** Côté du match résolu par noms d'équipes, null si indéterminé. */
  side: 'A' | 'B' | null;
  raw: Prisma.InputJsonValue;
  normalized: Prisma.InputJsonValue;
  /** Détail par manche (MapStatsEntry[]) quand la source le fournit. */
  perMap?: Prisma.InputJsonValue | null;
}

/** Détail d'une manche quand la source le connaît (map, score par équipe). */
export interface ProviderGameInfo {
  position: number;
  map?: string | null;
  scoreA?: number | null;
  scoreB?: number | null;
}

export interface ProviderResult {
  lines: ProviderStatLine[];
  /** Enrichissement des manches (fusionné dans match.gamesSummary). */
  games?: ProviderGameInfo[];
  /** Chemin/URL de la page source, mémorisé sur le match pour les fetchs suivants. */
  pageUrl?: string | null;
}

/**
 * Adapter de stats détaillées par jeu. Contrat : retourner null (ou lever)
 * si les stats ne sont pas encore disponibles, le job ingest-stats retentera
 * avec backoff. Chaque provider utilise politeFetch (1 req/s par hôte).
 */
export interface GameStatsProvider {
  readonly source: string;
  readonly gameId: GameId;
  fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null>;
  /**
   * Instantané des stats d'un match en cours, pour les sources qui publient
   * pendant la série (page VLR vivante, series state Grid). Optionnel : les
   * jeux sans source live n'affichent que le score Pandascore. Retour null
   * sans bruit si rien n'est disponible — le cycle suivant repassera.
   */
  fetchLiveStats?(match: Match, context: MatchContext): Promise<ProviderResult | null>;
  /**
   * Noms d'équipe candidats vus par la source autour du match, quand une seule
   * des deux équipes locales est reconnue : le nom d'en face est un alias
   * probable de l'équipe non résolue. Alimente le matching manuel assisté
   * (pré-remplissage admin). Optionnel selon les jeux.
   */
  suggestTeamNames?(
    match: Match,
    context: MatchContext,
  ): Promise<Array<{ side: 'A' | 'B'; name: string }>>;
}
