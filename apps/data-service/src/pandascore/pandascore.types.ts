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
  tier: string | null;
  league: PSLeague | null;
}

export interface PSTeamRef {
  id: number;
  name: string;
  acronym: string | null;
  image_url: string | null;
}

export interface PSPlayerRef {
  id: number;
  name: string;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  role: string | null;
}

export interface PSTeam extends PSTeamRef {
  players: PSPlayerRef[];
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
  opponents: Array<{ type: string; opponent: PSTeamRef }>;
  results: Array<{ team_id: number; score: number }>;
}
