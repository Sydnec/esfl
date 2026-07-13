'use client';

import { useCallback, useEffect, useState } from 'react';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import styles from './page.module.css';

interface TeamHit {
  id: string;
  gameId: string;
  name: string;
  acronym?: string | null;
  aliases: string[];
}

interface UnmatchedTeam extends TeamHit {
  matchId: string;
  matchName: string;
  endAt: string | null;
}

interface Suggestions {
  teamA: { id: string; name: string; aliases: string[] } | null;
  teamB: { id: string; name: string; aliases: string[] } | null;
  candidates: Array<{ side: 'A' | 'B'; name: string }>;
}

function gameLabel(gameId: string): string {
  return GAME_LABELS[gameId as GameId] ?? gameId;
}

/**
 * Matching manuel des équipes. Deux entrées : à gauche les équipes de matchs
 * récents sans stats (candidates à un alias manquant) avec des suggestions de
 * noms provider pré-remplies ; à droite une recherche libre. L'alias est
 * exploité par tous les providers et relance l'ingestion des matchs récents.
 */
export function TeamMatcher() {
  const { authedFetch } = useAuth();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Ajoute un alias et rafraîchit les deux panneaux.
  const applyAlias = useCallback(
    async (teamId: string, alias: string, label: string): Promise<string[] | null> => {
      const clean = alias.trim();
      if (!clean) return null;
      setBusy(teamId);
      setNote(null);
      try {
        const res = await authedFetch<{ aliases: string[]; reingested: number }>(
          `/data/admin/teams/${teamId}/aliases?alias=${encodeURIComponent(clean)}`,
          { method: 'POST' },
        );
        setNote(`Alias « ${clean} » ajouté à ${label} — ${res.reingested} match(s) relancé(s).`);
        return res.aliases;
      } catch {
        setNote('Ajout impossible (alias vide ou équipe introuvable)');
        return null;
      } finally {
        setBusy(null);
      }
    },
    [authedFetch],
  );

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Matching manuel des équipes</h2>
      <p className={styles.hint}>
        Ajoute le nom qu’un provider donne à une équipe (ex. « LP » pour largadosypelados).
        L’alias est utilisé par tous les jeux et relance l’ingestion des matchs récents.
      </p>
      {note && <p className={styles.note}>{note}</p>}
      <div className={styles.matcherGrid}>
        <UnmatchedPanel authedFetch={authedFetch} busy={busy} applyAlias={applyAlias} />
        <SearchPanel authedFetch={authedFetch} busy={busy} applyAlias={applyAlias} />
      </div>
    </section>
  );
}

type ApplyAlias = (teamId: string, alias: string, label: string) => Promise<string[] | null>;
type AuthedFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Panneau gauche : équipes à matcher + suggestions pré-remplies. */
function UnmatchedPanel({
  authedFetch,
  busy,
  applyAlias,
}: {
  authedFetch: AuthedFetch;
  busy: string | null;
  applyAlias: ApplyAlias;
}) {
  const [teams, setTeams] = useState<UnmatchedTeam[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [loadingSug, setLoadingSug] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTeams(await authedFetch<UnmatchedTeam[]>('/data/admin/unmatched-teams'));
    } catch {
      // panneau simplement vide en cas d'erreur
    }
  }, [authedFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  async function suggest(team: UnmatchedTeam) {
    setLoadingSug(team.id);
    try {
      const res = await authedFetch<Suggestions>(
        `/data/admin/matches/${team.matchId}/suggestions`,
      );
      const side = res.teamA?.id === team.id ? 'A' : res.teamB?.id === team.id ? 'B' : null;
      const names = res.candidates.filter((c) => c.side === side).map((c) => c.name);
      setSuggestions((current) => ({ ...current, [team.id]: names }));
    } catch {
      setSuggestions((current) => ({ ...current, [team.id]: [] }));
    } finally {
      setLoadingSug(null);
    }
  }

  async function pick(team: UnmatchedTeam, name: string) {
    const aliases = await applyAlias(team.id, name, team.name);
    if (aliases) {
      // Équipe désormais matchée : on la retire du panneau.
      setTeams((current) => current.filter((t) => t.id !== team.id));
    }
  }

  return (
    <div className={styles.matcherCol}>
      <h3 className={styles.colTitle}>À matcher ({teams.length})</h3>
      {teams.length === 0 ? (
        <p className={styles.empty}>Aucune équipe en attente sur les matchs récents.</p>
      ) : (
        <ul className={styles.unmatchedList}>
          {teams.map((team) => (
            <li key={team.id} className={styles.unmatchedItem}>
              <div className={styles.unmatchedHead}>
                <span>
                  <strong>{team.name}</strong> · {gameLabel(team.gameId)}
                </span>
                <button
                  className={styles.action}
                  disabled={loadingSug === team.id}
                  onClick={() => void suggest(team)}
                >
                  {loadingSug === team.id ? '…' : 'Suggérer'}
                </button>
              </div>
              <span className={styles.matchCtx}>{team.matchName}</span>
              {suggestions[team.id] &&
                (suggestions[team.id].length === 0 ? (
                  <span className={styles.empty}>Aucune suggestion trouvée côté provider.</span>
                ) : (
                  <span className={styles.aliasList}>
                    {suggestions[team.id].map((name) => (
                      <button
                        key={name}
                        className={styles.suggestChip}
                        disabled={busy === team.id}
                        onClick={() => void pick(team, name)}
                        title="Adopter ce nom comme alias"
                      >
                        + {name}
                      </button>
                    ))}
                  </span>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Panneau droit : recherche libre + ajout/suppression d'alias. */
function SearchPanel({
  authedFetch,
  busy,
  applyAlias,
}: {
  authedFetch: AuthedFetch;
  busy: string | null;
  applyAlias: ApplyAlias;
}) {
  const [gameId, setGameId] = useState<GameId | ''>('');
  const [query, setQuery] = useState('');
  const [teams, setTeams] = useState<TeamHit[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const search = useCallback(async () => {
    if (query.trim().length < 2) {
      setTeams([]);
      return;
    }
    const params = new URLSearchParams({ search: query.trim() });
    if (gameId) params.set('gameId', gameId);
    try {
      setTeams(await authedFetch<TeamHit[]>(`/data/admin/teams?${params}`));
    } catch {
      setTeams([]);
    }
  }, [authedFetch, query, gameId]);

  useEffect(() => {
    const timer = setTimeout(() => void search(), 350);
    return () => clearTimeout(timer);
  }, [search]);

  async function add(team: TeamHit) {
    const aliases = await applyAlias(team.id, draft[team.id] ?? '', team.name);
    if (aliases) {
      setTeams((current) => current.map((t) => (t.id === team.id ? { ...t, aliases } : t)));
      setDraft((current) => ({ ...current, [team.id]: '' }));
    }
  }

  async function remove(team: TeamHit, alias: string) {
    try {
      const res = await authedFetch<{ aliases: string[] }>(
        `/data/admin/teams/${team.id}/aliases?alias=${encodeURIComponent(alias)}`,
        { method: 'DELETE' },
      );
      setTeams((current) =>
        current.map((t) => (t.id === team.id ? { ...t, aliases: res.aliases } : t)),
      );
    } catch {
      // ignoré : l'état se resynchronise à la prochaine recherche
    }
  }

  return (
    <div className={styles.matcherCol}>
      <h3 className={styles.colTitle}>Recherche</h3>
      <div className={styles.searchRow}>
        <select
          className={styles.select}
          value={gameId}
          onChange={(event) => setGameId(event.target.value as GameId | '')}
        >
          <option value="">Tous</option>
          {GAME_IDS.map((id) => (
            <option key={id} value={id}>
              {GAME_LABELS[id]}
            </option>
          ))}
        </select>
        <input
          className={styles.searchInput}
          placeholder="Nom d’équipe…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {teams.map((team) => (
        <div key={team.id} className={styles.unmatchedItem}>
          <div className={styles.unmatchedHead}>
            <span>
              <strong>{team.name}</strong>
              {team.acronym ? ` (${team.acronym})` : ''} · {gameLabel(team.gameId)}
            </span>
          </div>
          <span className={styles.aliasList}>
            {team.aliases.map((alias) => (
              <button
                key={alias}
                className={styles.aliasChip}
                disabled={busy === team.id}
                onClick={() => void remove(team, alias)}
                title="Retirer cet alias"
              >
                {alias} ×
              </button>
            ))}
            <input
              className={styles.aliasInput}
              placeholder="nom provider"
              value={draft[team.id] ?? ''}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [team.id]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void add(team);
              }}
            />
            <button
              className={styles.action}
              disabled={busy === team.id}
              onClick={() => void add(team)}
            >
              +
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
