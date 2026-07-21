import type { GameId } from '@esfl/contracts';

/**
 * Tout ce qui distingue un jeu d'un autre côté front : forme de l'identifiant
 * provider attendu de l'admin, et libellés de la page match.
 *
 * Le parcours, lui, est identique pour les trois. Cette table est le seul
 * endroit où les différences s'expriment, plutôt que des ternaires sur
 * `gameId` disséminés dans le JSX — où CS2, arrivé après, se voyait servir les
 * libellés d'un autre jeu.
 */
export interface GameProfile {
  /** Source spécialisée du jeu, telle qu'elle se nomme côté data-service. */
  source: string;
  /** Invite du champ de saisie d'identité provider. */
  placeholderIdentite: string;
  /** Invite du champ d'alias/nom provider. */
  placeholderAlias: string;
  /** Le champ attend une URL : il lui faut toute la largeur. */
  champLarge: boolean;
  /**
   * La source sait résoudre un match depuis le lien de sa page, ce qui offre à
   * l'admin une correction directe en plus des alias d'équipe. Aujourd'hui seul
   * VLR l'implémente côté data-service (`admin/matches/:id/stats-page`) ; le
   * jour où une autre source l'expose, seule cette ligne change.
   */
  correctionParLien: boolean;
  /** Nom de la source, affiché en lien vers la page de stats d'origine. */
  libelleSource: string;
  /** Préfixe à ajouter quand la source ne stocke qu'un chemin relatif. */
  baseUrlStats: string | null;
  /** Personnage joué : « Agent » en Valorant, « Champion » en LoL. */
  libellePersonnage: string;
  /** La durée d'une manche est-elle signifiante ? (variable en LoL seulement) */
  afficheDuree: boolean;
  /** Manche nommée par sa map, ou numérotée quand il n'y a pas de choix de map. */
  mancheNumerotee: boolean;
  /** Les rôles ont un ordre d'usage (TOP/JUN/MID/ADC/SUP) à respecter. */
  triParRole: boolean;
}

export const GAME_PROFILE: Record<GameId, GameProfile> = {
  cs2: {
    source: 'bo3',
    placeholderIdentite: 'id bo3 de l’équipe',
    placeholderAlias: 'alias manuel…',
    champLarge: false,
    correctionParLien: false,
    libelleSource: 'bo3.gg',
    baseUrlStats: null,
    libellePersonnage: 'Agent',
    afficheDuree: false,
    mancheNumerotee: false,
    triParRole: false,
  },
  valorant: {
    source: 'vlr',
    placeholderIdentite: 'lien vlr.gg/team/… ou id',
    placeholderAlias: 'alias manuel…',
    champLarge: false,
    correctionParLien: true,
    libelleSource: 'VLR.gg',
    baseUrlStats: 'https://www.vlr.gg',
    libellePersonnage: 'Agent',
    afficheDuree: false,
    mancheNumerotee: false,
    triParRole: false,
  },
  lol: {
    source: 'leaguepedia',
    placeholderIdentite: 'lien lol.fandom.com ou nom…',
    placeholderAlias: 'nom ou lien lol.fandom.com…',
    champLarge: true,
    correctionParLien: false,
    libelleSource: 'Leaguepedia',
    baseUrlStats: null,
    libellePersonnage: 'Champion',
    afficheDuree: true,
    mancheNumerotee: true,
    triParRole: true,
  },
};

/** Repli sûr : un jeu inconnu du front ne doit pas casser la page. */
export function gameProfile(gameId: string): GameProfile {
  return GAME_PROFILE[gameId as GameId] ?? GAME_PROFILE.cs2;
}
