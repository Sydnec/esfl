/** Sous-ensembles typés des réponses Pandascore utilisés par l'ingestion. */

export interface PSLeague {
  id: number;
  name: string;
  image_url: string | null;
}

export interface PSSerie {
  id: number;
  full_name: string;
  slug: string | null;
  begin_at: string | null;
  end_at: string | null;
  /** Toujours null sur les séries : le tier Pandascore est porté par les tournois. */
  tier: string | null;
  /** Tournois de la série (inclus dans le payload) : leur `tier` alimente celui de la compétition. */
  tournaments?: Array<{ id: number; tier: string | null }>;
  league: PSLeague | null;
}

export interface PSTeamRef {
  id: number;
  name: string;
  acronym: string | null;
  image_url: string | null;
  /** Code pays ISO2. */
  location: string | null;
}

export interface PSPlayerRef {
  id: number;
  name: string;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  role: string | null;
  /** Code pays ISO2. */
  nationality: string | null;
}

export interface PSTeam extends PSTeamRef {
  players: PSPlayerRef[];
}

export interface PSGame {
  id: number;
  position: number;
  status: string;
  finished: boolean;
  /** Durée de la manche en secondes (souvent null avant la fin). */
  length: number | null;
  winner: { id: number | null; type: string } | null;
}

export interface PSStream {
  language: string | null;
  official: boolean;
  raw_url: string | null;
}

export interface PSMatch {
  id: number;
  name: string;
  status: 'not_started' | 'running' | 'finished' | 'canceled' | 'postponed';
  scheduled_at: string | null;
  begin_at: string | null;
  end_at: string | null;
  serie_id: number;
  winner_id: number | null;
  number_of_games: number | null;
  opponents: Array<{ type: string; opponent: PSTeamRef }>;
  results: Array<{ team_id: number; score: number }>;
  games: PSGame[] | null;
  streams_list: PSStream[] | null;
}
