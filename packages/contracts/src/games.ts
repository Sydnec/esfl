/** Identifiants des jeux couverts par ESFL. Alignés sur les slugs Pandascore.
 * Rocket League est retiré pour l'instant (couverture ballchasing trop
 * aléatoire) : réintroduire l'id ici fera remonter tous les points à recâbler. */
export const GAME_IDS = ['cs2', 'valorant', 'lol'] as const;

export type GameId = (typeof GAME_IDS)[number];

export const GAME_LABELS: Record<GameId, string> = {
  cs2: 'Counter-Strike 2',
  valorant: 'Valorant',
  lol: 'League of Legends',
};

/** Libellés courts pour les affichages condensés (une seule ligne étroite). */
export const GAME_SHORT_LABELS: Record<GameId, string> = {
  cs2: 'CS2',
  valorant: 'Valorant',
  lol: 'LoL',
};

/** Préfixes de chemin de l'API Pandascore par jeu (ex: /csgo/series). */
export const PANDASCORE_PATHS: Record<GameId, string> = {
  cs2: 'csgo',
  valorant: 'valorant',
  lol: 'lol',
};
