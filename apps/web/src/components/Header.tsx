'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';
import styles from './Header.module.css';

export function Header() {
  const { user, logout } = useAuth();
  const router = useRouter();

  return (
    <header className={styles.header}>
      <Link href={user ? '/dashboard' : '/'} className={styles.brand}>
        ESFL
      </Link>
      <nav className={styles.nav}>
        {user ? (
          <>
            <span className={styles.username}>{user.username}</span>
            <button
              className={styles.logout}
              onClick={() => void logout().then(() => router.push('/login'))}
            >
              Se déconnecter
            </button>
          </>
        ) : (
          <Link href="/login">Se connecter</Link>
        )}
      </nav>
    </header>
  );
}
