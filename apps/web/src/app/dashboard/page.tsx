'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import styles from './page.module.css';

export default function DashboardPage() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return <main className={styles.main}>Chargement…</main>;
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>Salut {user.username}</h1>
        <button className={styles.logout} onClick={() => void logout().then(() => router.push('/login'))}>
          Se déconnecter
        </button>
      </header>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Mes ligues</h2>
        <p className={styles.empty}>Aucune ligue pour le moment — la création arrive bientôt.</p>
      </section>
    </main>
  );
}
