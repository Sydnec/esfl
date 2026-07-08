'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { ApiError } from '@/lib/api';
import type { League } from '@/lib/types';
import styles from './page.module.css';

export default function DashboardPage() {
  const { user, loading, authedFetch } = useAuth();
  const router = useRouter();
  const [leagues, setLeagues] = useState<League[] | null>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    authedFetch<League[]>('/fantasy/leagues')
      .then(setLeagues)
      .catch(() => setError('Impossible de charger tes ligues'));
  }, [user, authedFetch]);

  async function handleJoin(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const league = await authedFetch<League>('/fantasy/leagues/join', {
        method: 'POST',
        body: JSON.stringify({ inviteCode: inviteCode.trim().toUpperCase() }),
      });
      router.push(`/leagues/${league.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de rejoindre la ligue');
    }
  }

  if (loading || !user) {
    return <main className={styles.main}>Chargement…</main>;
  }

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Mes ligues</h1>
        <Link href="/leagues/new" className={styles.createLink}>
          Créer une ligue
        </Link>
      </div>

      {leagues === null ? (
        <p className={styles.empty}>Chargement…</p>
      ) : leagues.length === 0 ? (
        <p className={styles.empty}>
          Aucune ligue pour le moment. Crée la tienne ou rejoins celle d’un ami.
        </p>
      ) : (
        <ul className={styles.leagues}>
          {leagues.map((league) => (
            <li key={league.id}>
              <Link href={`/leagues/${league.id}`} className={styles.league}>
                <span className={styles.leagueName}>{league.name}</span>
                <span className={styles.leagueMeta}>
                  {league._count?.members ?? '?'} membre(s) · {league.competitions.length}{' '}
                  compétition(s) · roster {league.rosterSize} · lock {league.lockMatchDays}j
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className={styles.joinSection}>
        <h2 className={styles.sectionTitle}>Rejoindre une ligue</h2>
        <form className={styles.joinForm} onSubmit={handleJoin}>
          <input
            className={styles.input}
            placeholder="Code d’invitation"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            required
          />
          <button className={styles.submit} type="submit">
            Rejoindre
          </button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </main>
  );
}
