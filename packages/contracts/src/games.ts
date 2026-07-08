/** Identifiants des jeux couverts par ESFL. Alignés sur les slugs Pandascore. */
export const GAME_IDS = ['cs2', 'valorant', 'lol', 'rl'] as const;

export type GameId = (typeof GAME_IDS)[number];

export const GAME_LABELS: Record<GameId, string> = {
  cs2: 'Counter-Strike 2',
  valorant: 'Valorant',
  lol: 'League of Legends',
  rl: 'Rocket League',
};

/** Slugs des jeux côté Pandascore (videogame.slug). */
export const PANDASCORE_GAME_SLUGS: Record<GameId, string> = {
  cs2: 'cs-go',
  valorant: 'valorant',
  lol: 'league-of-legends',
  rl: 'rl',
};
