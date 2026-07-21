import type { GameId } from '@esfl/contracts';

/**
 * Ce que l'admin doit saisir pour rattacher une équipe à sa source, par jeu.
 *
 * Seule la forme de l'identifiant change d'une source à l'autre ; le reste du
 * parcours est identique. Cette table est le seul endroit où cette différence
 * s'exprime, plutôt que des ternaires sur `gameId` répartis dans le JSX.
 */
export interface ProviderInput {
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
}

export const PROVIDER_INPUT: Record<GameId, ProviderInput> = {
  cs2: {
    source: 'bo3',
    placeholderIdentite: 'id bo3 de l’équipe',
    placeholderAlias: 'alias manuel…',
    champLarge: false,
    correctionParLien: false,
  },
  valorant: {
    source: 'vlr',
    placeholderIdentite: 'lien vlr.gg/team/… ou id',
    placeholderAlias: 'alias manuel…',
    champLarge: false,
    correctionParLien: true,
  },
  lol: {
    source: 'leaguepedia',
    placeholderIdentite: 'lien lol.fandom.com ou nom…',
    placeholderAlias: 'nom ou lien lol.fandom.com…',
    champLarge: true,
    correctionParLien: false,
  },
};

/** Repli sûr : un jeu inconnu du front ne doit pas casser la page admin. */
export function providerInput(gameId: string): ProviderInput {
  return PROVIDER_INPUT[gameId as GameId] ?? PROVIDER_INPUT.cs2;
}
