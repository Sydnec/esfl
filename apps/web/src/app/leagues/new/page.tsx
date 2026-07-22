'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GAME_IDS, GAME_LABELS, GameId } from '@esfl/contracts';
import { useAuth } from '@/components/AuthProvider';
import { ApiError, cheminCatalogue, request } from '@/lib/api';
import type { Competition, League } from '@/lib/types';
import styles from './page.module.css';

export default function NewLeaguePage() {
  const { user, loading, authedFetch } = useAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [rosterSize, setRosterSize] = useState(5);
  const [lockMatchDays, setLockMatchDays] = useState(2);
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    request<Competition[]>(cheminCatalogue())
      .then(setCompetitions)
      .catch(() => setError('Référentiel des compétitions indisponible'));
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term
      ? competitions.filter((competition) => competition.name.toLowerCase().includes(term))
      : competitions;
  }, [competitions, search]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (selected.size === 0) {
      setError('Choisis au moins une compétition à suivre');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const league = await authedFetch<League>('/fantasy/leagues', {
        method: 'POST',
        body: JSON.stringify({
          name,
          rosterSize,
          lockMatchDays,
          competitionIds: [...selected],
        }),
      });
      router.push(`/leagues/${league.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Création impossible');
      setSubmitting(false);
    }
  }

  if (loading || !user) return <main className={styles.main}>Chargement…</main>;

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Créer une ligue</h1>
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.label}>
          Nom de la ligue
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={3}
            maxLength={40}
          />
        </label>
        <div className={styles.row}>
          <label className={styles.label}>
            Taille du roster par journée
            <input
              className={styles.input}
              type="number"
              min={1}
              max={10}
              value={rosterSize}
              onChange={(e) => setRosterSize(Number(e.target.value))}
            />
          </label>
          <label className={styles.label}>
            Journées de verrouillage après un pick
            <input
              className={styles.input}
              type="number"
              min={0}
              max={10}
              value={lockMatchDays}
              onChange={(e) => setLockMatchDays(Number(e.target.value))}
            />
          </label>
        </div>

        <section>
          <h2 className={styles.sectionTitle}>Compétitions suivies ({selected.size})</h2>
          <input
            className={styles.input}
            placeholder="Rechercher une compétition…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {GAME_IDS.map((gameId: GameId) => {
            const list = filtered.filter((competition) => competition.gameId === gameId);
            if (list.length === 0) return null;
            return (
              <div key={gameId} className={styles.gameGroup}>
                <h3 className={styles.gameTitle}>{GAME_LABELS[gameId]}</h3>
                <ul className={styles.competitions}>
                  {list.map((competition) => (
                    <li key={competition.id}>
                      <label className={styles.competition}>
                        <input
                          type="checkbox"
                          checked={selected.has(competition.id)}
                          onChange={() => toggle(competition.id)}
                        />
                        <span>{competition.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>

        {error && <p className={styles.error}>{error}</p>}
        <button className={styles.submit} type="submit" disabled={submitting}>
          Créer la ligue
        </button>
      </form>
    </main>
  );
}
