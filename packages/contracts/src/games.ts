/** Identifiants des jeux couverts par ESFL. Alignés sur les slugs Pandascore. */
export const GAME_IDS = ['cs2', 'valorant', 'lol', 'rl'] as const;

export type GameId = (typeof GAME_IDS)[number];

export const GAME_LABELS: Record<GameId, string> = {
  cs2: 'Counter-Strike 2',
  valorant: 'Valorant',
  lol: 'League of Legends',
  rl: 'Rocket League',
};

/** Libellés courts pour les affichages condensés. */
export const GAME_SHORT_LABELS: Record<GameId, string> = {
  cs2: 'CS',
  valorant: 'Valo',
  lol: 'LoL',
  rl: 'RL',
};

/** Préfixes de chemin de l'API Pandascore par jeu (ex: /csgo/series). */
export const PANDASCORE_PATHS: Record<GameId, string> = {
  cs2: 'csgo',
  valorant: 'valorant',
  lol: 'lol',
  rl: 'rl',
};
