'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { formatDateTime } from '@/lib/format';
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
  /** Noms provider candidats vus par la source, pré-remplis (name-mismatch). */
  candidates: string[];
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
        const res = await authedFetch<{
          aliases: string[];
          reingested: number;
          added: string[];
          redundant: boolean;
        }>(`/data/admin/teams/${teamId}/aliases?alias=${encodeURIComponent(clean)}`, {
          method: 'POST',
        });
        if (res.redundant) {
          setNote(
            `Le nom correspond déjà à ${label} : le souci n’est pas le nom mais la couverture. Rien ajouté.`,
          );
          return null;
        }
        setNote(
          `Alias ajouté(s) à ${label} : ${res.added.join(', ')} · ${res.reingested} match(s) relancé(s).`,
        );
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

  // Valorant : on ne devine pas un alias, on colle la page VLR du match, qui
  // relance directement l'ingestion (le provider parse cette page).
  const applyVlrPage = useCallback(
    async (matchId: string, url: string, label: string): Promise<boolean> => {
      const clean = url.trim();
      if (!clean) return false;
      setBusy(matchId);
      setNote(null);
      try {
        await authedFetch(
          `/data/admin/matches/${matchId}/stats-page?url=${encodeURIComponent(clean)}`,
          { method: 'POST' },
        );
        setNote(`Page VLR appliquée à ${label}, ingestion relancée.`);
        return true;
      } catch {
        setNote('Page VLR invalide ou match introuvable');
        return false;
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
        Seuls les vrais problèmes de nom sont listés (les trous de couverture sont écartés). Pour
        CS2, ajoute le nom qu’un provider donne à une équipe (ex. « BB Team » pour
        BetBoom Team) : l’alias relance l’ingestion des matchs récents. Pour LoL, tu peux coller
        le lien de l’équipe sur lol.fandom.com (le nom est extrait automatiquement). Pour Valorant,
        colle directement le lien du match sur VLR.gg.
      </p>
      {note && <p className={styles.note}>{note}</p>}
      <div className={styles.matcherGrid}>
        <UnmatchedPanel
          authedFetch={authedFetch}
          busy={busy}
          applyAlias={applyAlias}
          applyVlrPage={applyVlrPage}
        />
        <SearchPanel authedFetch={authedFetch} busy={busy} applyAlias={applyAlias} />
      </div>
      <MissingProviderIdPanel authedFetch={authedFetch} />
    </section>
  );
}

/** Équipe LoL/Valorant sans identité chez la source de stats. */
interface MissingProviderIdTeam {
  id: string;
  gameId: string;
  name: string;
  acronym: string | null;
  aliases: string[];
  players: number;
  matches: number;
}

/**
 * Identités provider manquantes (LoL/Valorant). Sans elle, une équipe n'a ni
 * roster spécialisé ni fiche enrichie, et son matching de stats repose sur le
 * seul nom Pandascore. La saisie est validée contre la fiche source avant
 * d'être enregistrée : on voit tout de suite si on a visé la bonne équipe.
 */
function MissingProviderIdPanel({ authedFetch }: { authedFetch: AuthedFetch }) {
  const [teams, setTeams] = useState<MissingProviderIdTeam[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTeams(await authedFetch<MissingProviderIdTeam[]>('/data/admin/teams/missing-provider-id'));
    } catch {
      // panneau simplement vide en cas d'erreur
    }
  }, [authedFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(team: MissingProviderIdTeam) {
    const value = (draft[team.id] ?? '').trim();
    if (!value) return;
    setBusy(team.id);
    setNote(null);
    try {
      const res = await authedFetch<{
        providerTeamId: string;
        profile: { name?: string | null; roster: number };
        reingested: number;
      }>(`/data/admin/teams/${team.id}/provider-id?value=${encodeURIComponent(value)}`, {
        method: 'POST',
      });
      setNote(
        `${team.name} rattachée à « ${res.profile.name ?? res.providerTeamId} » ` +
          `(${res.profile.roster} joueurs), ${res.reingested} match(s) relancé(s).`,
      );
      setDraft((current) => ({ ...current, [team.id]: '' }));
      await load();
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Identifiant refusé par la source');
    } finally {
      setBusy(null);
    }
  }

  if (teams.length === 0) return null;

  return (
    <div className={styles.matcherCol}>
      <h3 className={styles.colTitle}>Identités provider manquantes</h3>
      <p className={styles.hint}>
        LoL : nom ou lien lol.fandom.com. Valorant : lien vlr.gg/team/… ou id numérique. La fiche
        est vérifiée chez la source avant enregistrement, puis le roster et les matchs sans stats
        sont relancés.
      </p>
      {note && <p className={styles.note}>{note}</p>}
      {teams.map((team) => (
        <div key={team.id} className={styles.unmatchedItem}>
          <div className={styles.unmatchedHead}>
            <span>
              <strong>{team.name}</strong>
              {team.acronym ? ` (${team.acronym})` : ''} · {gameLabel(team.gameId)}
            </span>
            <span>
              {team.matches} match(s), {team.players} joueur(s)
            </span>
          </div>
          <span className={styles.aliasList}>
            <input
              className={styles.searchInput}
              placeholder={team.gameId === 'lol' ? 'lien lol.fandom.com ou nom…' : 'lien vlr.gg/team/… ou id'}
              value={draft[team.id] ?? ''}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [team.id]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void apply(team);
              }}
            />
            <button
              className={styles.action}
              disabled={busy === team.id}
              onClick={() => void apply(team)}
            >
              {busy === team.id ? '…' : 'Rattacher'}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

type ApplyAlias = (teamId: string, alias: string, label: string) => Promise<string[] | null>;
type ApplyVlrPage = (matchId: string, url: string, label: string) => Promise<boolean>;
type AuthedFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Une ligne du panneau « À matcher » : une équipe (alias) ou un match (lien VLR). */
type PanelItem =
  | { kind: 'team'; key: string; gameId: string; team: UnmatchedTeam }
  | {
      kind: 'match';
      key: string;
      gameId: string;
      matchId: string;
      matchName: string;
      endAt: string | null;
    };

/** Panneau gauche : équipes à matcher + suggestions pré-remplies. */
function UnmatchedPanel({
  authedFetch,
  busy,
  applyAlias,
  applyVlrPage,
}: {
  authedFetch: AuthedFetch;
  busy: string | null;
  applyAlias: ApplyAlias;
  applyVlrPage: ApplyVlrPage;
}) {
  const [teams, setTeams] = useState<UnmatchedTeam[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [loadingSug, setLoadingSug] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [vlrDraft, setVlrDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<GameId | ''>('');

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

  // Valorant se matche par match (on colle un lien de match), pas par équipe :
  // on dédoublonne par match pour ne pas afficher deux lignes d'une rencontre.
  // Les autres jeux restent une ligne par équipe (un alias par équipe).
  const items = useMemo<PanelItem[]>(() => {
    const result: PanelItem[] = [];
    const seenMatch = new Set<string>();
    for (const team of teams) {
      if (team.gameId === 'valorant') {
        if (seenMatch.has(team.matchId)) continue;
        seenMatch.add(team.matchId);
        result.push({
          kind: 'match',
          key: team.matchId,
          gameId: team.gameId,
          matchId: team.matchId,
          matchName: team.matchName,
          endAt: team.endAt,
        });
      } else {
        result.push({ kind: 'team', key: team.id, gameId: team.gameId, team });
      }
    }
    return result;
  }, [teams]);

  // Compteur par jeu pour les puces de filtre.
  const countByGame = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.gameId, (counts.get(item.gameId) ?? 0) + 1);
    return counts;
  }, [items]);
  const visible = filter ? items.filter((item) => item.gameId === filter) : items;

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

  async function manualAdd(team: UnmatchedTeam) {
    await pick(team, draft[team.id] ?? '');
  }

  // Valorant : applique la page VLR du match et retire toutes ses équipes du panneau.
  async function applyVlr(matchId: string, matchName: string) {
    const ok = await applyVlrPage(matchId, vlrDraft[matchId] ?? '', matchName);
    if (ok) {
      setVlrDraft((current) => ({ ...current, [matchId]: '' }));
      setTeams((current) => current.filter((t) => t.matchId !== matchId));
    }
  }

  return (
    <div className={styles.matcherCol}>
      <h3 className={styles.colTitle}>À matcher ({items.length})</h3>
      {items.length > 0 && (
        <div className={styles.filterRow}>
          <button
            className={filter === '' ? styles.filterChipActive : styles.filterChip}
            onClick={() => setFilter('')}
          >
            Tous ({items.length})
          </button>
          {GAME_IDS.filter((id) => countByGame.has(id)).map((id) => (
            <button
              key={id}
              className={filter === id ? styles.filterChipActive : styles.filterChip}
              onClick={() => setFilter(id)}
            >
              {GAME_LABELS[id]} ({countByGame.get(id)})
            </button>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <p className={styles.empty}>Rien en attente sur les matchs récents.</p>
      ) : (
        <ul className={styles.unmatchedList}>
          {visible.map((item) =>
            item.kind === 'match' ? (
              <li key={item.key} className={styles.unmatchedItem}>
                <div className={styles.unmatchedHead}>
                  <span>
                    <span className={styles.badge} data-game={item.gameId}>
                      {gameLabel(item.gameId)}
                    </span>{' '}
                    <Link href={`/matches/${item.matchId}`}>
                      <strong>{item.matchName}</strong>
                    </Link>
                  </span>
                </div>
                {item.endAt && (
                  <span className={styles.matchCtx}>{formatDateTime(item.endAt)}</span>
                )}
                <span className={styles.aliasList}>
                  <input
                    className={styles.searchInput}
                    placeholder="lien du match VLR.gg…"
                    value={vlrDraft[item.matchId] ?? ''}
                    onChange={(event) =>
                      setVlrDraft((current) => ({ ...current, [item.matchId]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void applyVlr(item.matchId, item.matchName);
                    }}
                  />
                  <button
                    className={styles.action}
                    disabled={busy === item.matchId || !(vlrDraft[item.matchId] ?? '').trim()}
                    onClick={() => void applyVlr(item.matchId, item.matchName)}
                  >
                    Appliquer
                  </button>
                </span>
              </li>
            ) : (
              <li key={item.key} className={styles.unmatchedItem}>
                <div className={styles.unmatchedHead}>
                  <span>
                    <span className={styles.badge} data-game={item.gameId}>
                      {gameLabel(item.gameId)}
                    </span>{' '}
                    <strong>{item.team.name}</strong>
                  </span>
                  <button
                    className={styles.action}
                    disabled={loadingSug === item.team.id}
                    onClick={() => void suggest(item.team)}
                  >
                    {loadingSug === item.team.id ? '…' : 'Suggérer'}
                  </button>
                </div>
                <span className={styles.matchCtx}>
                  <Link href={`/matches/${item.team.matchId}`}>{item.team.matchName}</Link>
                  {item.team.endAt ? ` · ${formatDateTime(item.team.endAt)}` : ''}
                </span>
                {(() => {
                  // Chips pré-remplis via les candidats du diagnostic ; « Suggérer »
                  // peut les rafraîchir à la demande.
                  const shown = suggestions[item.team.id] ?? item.team.candidates;
                  if (!shown) return null;
                  return shown.length === 0 ? (
                    <span className={styles.empty}>Aucune suggestion trouvée côté provider.</span>
                  ) : (
                    <span className={styles.aliasList}>
                      {shown.map((name) => (
                        <button
                          key={name}
                          className={styles.suggestChip}
                          disabled={busy === item.team.id}
                          onClick={() => void pick(item.team, name)}
                          title="Adopter ce nom comme alias"
                        >
                          + {name}
                        </button>
                      ))}
                    </span>
                  );
                })()}
                <span className={styles.aliasList}>
                  <input
                    className={item.gameId === 'lol' ? styles.searchInput : styles.aliasInput}
                    placeholder={
                      item.gameId === 'lol' ? 'nom ou lien lol.fandom.com…' : 'alias manuel…'
                    }
                    value={draft[item.team.id] ?? ''}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, [item.team.id]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void manualAdd(item.team);
                    }}
                  />
                  <button
                    className={styles.action}
                    disabled={busy === item.team.id || !(draft[item.team.id] ?? '').trim()}
                    onClick={() => void manualAdd(item.team)}
                  >
                    Ajouter
                  </button>
                </span>
              </li>
            ),
          )}
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
              className={team.gameId === 'lol' ? styles.searchInput : styles.aliasInput}
              placeholder={team.gameId === 'lol' ? 'nom ou lien lol.fandom.com…' : 'nom provider'}
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
