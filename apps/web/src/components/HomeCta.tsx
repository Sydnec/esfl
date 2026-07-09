'use client';

import Link from 'next/link';
import { useAuth } from './AuthProvider';
import styles from './HomeCta.module.css';

/** Boutons d'inscription/connexion, masqués quand une session est active. */
export function HomeCta() {
  const { user, loading } = useAuth();
  if (loading || user) return null;

  return (
    <div className={styles.actions}>
      <Link href="/register" className={styles.cta}>
        Créer un compte
      </Link>
      <Link href="/login" className={styles.secondary}>
        Se connecter
      </Link>
    </div>
  );
}
