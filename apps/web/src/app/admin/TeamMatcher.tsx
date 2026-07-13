'use client';

import { useCallback, useEffect, useState } from 'react';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import styles from './page.module.css';

interface TeamHit {
  id: string;
  gameId: string;
  name: string;
  acronym: string | null;
  aliases: string[];
}

/**
 * Matching manuel des équipes : recherche une équipe et lui ajoute le nom
 * qu'un provider (VLR, Grid, Leaguepedia, ballchasing) lui donne. L'alias est
 * exploité par tous les providers ; l'ajout relance l'ingestion des matchs
 * récents de l'équipe.
 */
export function TeamMatcher() {
  const { authedFetch } = useAuth();
  const [gameId, setGameId] = useState<GameId | ''>('');
  const [query, setQuery] = useState('');
  const [teams, setTeams] = useState<TeamHit[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      setNote('Recherche impossible');
    }
  }, [authedFetch, query, gameId]);

  // Recherche débattue : on attend 350 ms après la dernière frappe.
  useEffect(() => {
    const timer = setTimeout(() => void search(), 350);
    return () => clearTimeout(timer);
  }, [search]);

  async function addAlias(team: TeamHit) {
    const alias = (draft[team.id] ?? '').trim();
    if (!alias) return;
    setBusy(team.id);
    setNote(null);
    try {
      const res = await authedFetch<{ aliases: string[]; reingested: number }>(
        `/data/admin/teams/${team.id}/aliases?alias=${encodeURIComponent(alias)}`,
        { method: 'POST' },
      );
      setTeams((current) =>
        current.map((t) => (t.id === team.id ? { ...t, aliases: res.aliases } : t)),
      );
      setDraft((current) => ({ ...current, [team.id]: '' }));
      setNote(`Alias « ${alias} » ajouté à ${team.name} — ${res.reingested} match(s) relancé(s).`);
    } catch {
      setNote('Ajout impossible (alias vide ou équipe introuvable)');
    } finally {
      setBusy(null);
    }
  }

  async function removeAlias(team: TeamHit, alias: string) {
    setBusy(team.id);
    try {
      const res = await authedFetch<{ aliases: string[] }>(
        `/data/admin/teams/${team.id}/aliases?alias=${encodeURIComponent(alias)}`,
        { method: 'DELETE' },
      );
      setTeams((current) =>
        current.map((t) => (t.id === team.id ? { ...t, aliases: res.aliases } : t)),
      );
    } catch {
      setNote('Suppression impossible');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Matching manuel des équipes</h2>
      <p className={styles.hint}>
        Recherche une équipe puis ajoute le nom qu’un provider lui donne (ex. « LP » pour
        largadosypelados). L’alias est utilisé par tous les jeux et relance l’ingestion des matchs
        récents.
      </p>
      <div className={styles.searchRow}>
        <select
          className={styles.select}
          value={gameId}
          onChange={(event) => setGameId(event.target.value as GameId | '')}
        >
          <option value="">Tous les jeux</option>
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
      {note && <p className={styles.note}>{note}</p>}
      {teams.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Jeu</th>
              <th>Équipe</th>
              <th>Alias</th>
              <th>Ajouter</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team) => (
              <tr key={team.id}>
                <td>{GAME_LABELS[team.gameId as GameId] ?? team.gameId}</td>
                <td>
                  {team.name}
                  {team.acronym ? ` (${team.acronym})` : ''}
                </td>
                <td>
                  {team.aliases.length === 0 ? (
                    <span className={styles.empty}>—</span>
                  ) : (
                    <span className={styles.aliasList}>
                      {team.aliases.map((alias) => (
                        <button
                          key={alias}
                          className={styles.aliasChip}
                          disabled={busy === team.id}
                          onClick={() => void removeAlias(team, alias)}
                          title="Retirer cet alias"
                        >
                          {alias} ×
                        </button>
                      ))}
                    </span>
                  )}
                </td>
                <td>
                  <div className={styles.searchRow}>
                    <input
                      className={styles.aliasInput}
                      placeholder="nom provider"
                      value={draft[team.id] ?? ''}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [team.id]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void addAlias(team);
                      }}
                    />
                    <button
                      className={styles.action}
                      disabled={busy === team.id}
                      onClick={() => void addAlias(team)}
                    >
                      +
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
