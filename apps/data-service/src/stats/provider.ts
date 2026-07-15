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
  /** Nom d'équipe brut de la source pour ce joueur : sert à résoudre le côté et
   * apprendre l'alias via les joueurs quand le nom ne matche pas le nôtre. */
  teamName?: string | null;
  raw: Prisma.InputJsonValue;
  normalized: Prisma.InputJsonValue;
  /** Détail par manche (MapStatsEntry[]) quand la source le fournit. */
  perMap?: Prisma.InputJsonValue | null;
}

/** Détail d'une manche quand la source le connaît (map, score par équipe). */
export interface ProviderGameInfo {
  position: number;
  map?: string | null;
  /** Scores résolus par côté (providers dont les noms d'équipe matchent). */
  scoreA?: number | null;
  scoreB?: number | null;
  /** Scores bruts par nom d'équipe source : l'ingestion les rattache aux côtés
   * via les joueurs (robuste quand les noms d'équipe diffèrent des nôtres). */
  teams?: Array<{ name: string; score: number | null }>;
}

export interface ProviderResult {
  lines: ProviderStatLine[];
  /** Enrichissement des manches (fusionné dans match.gamesSummary). */
  games?: ProviderGameInfo[];
  /** Chemin/URL de la page source, mémorisé sur le match pour les fetchs suivants. */
  pageUrl?: string | null;
  /**
   * Identifiant de l'équipe chez la source, par côté résolu — appris et
   * persisté sur `Team.providerIds` (fiable car le match a été trouvé et les
   * deux équipes reconnues). Ex. VLR : id numérique ; Leaguepedia : nom canonique.
   */
  teamIds?: { A?: string | null; B?: string | null };
}

/** Titulaire renvoyé par une source spécialisée (Leaguepedia, VLR…). */
export interface StarterRef {
  name: string;
  role?: string | null;
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
   * Titulaires actuels d'une équipe selon la source spécialisée du jeu
   * (Leaguepedia pour LoL, VLR pour Valorant). Sert à ne garder actifs que les
   * vrais titulaires ; null si la source ne sait pas répondre (→ fallback
   * Pandascore). Optionnel : jeux sans source de roster fiable.
   */
  fetchStarters?(
    teamName: string,
    aliases: string[],
    providerTeamId?: string | null,
  ): Promise<StarterRef[] | null>;
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
