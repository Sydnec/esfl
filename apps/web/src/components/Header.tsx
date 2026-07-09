'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';
import styles from './Header.module.css';

export function Header() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <header className={styles.bar}>
      <div className={styles.header}>
      <div className={styles.left}>
        <Link href="/" className={styles.brand}>
          ESFL
        </Link>
        <nav className={styles.links}>
          <Link href="/" className={pathname === '/' ? styles.active : styles.link}>
            Accueil
          </Link>
          {user && (
            <Link
              href="/dashboard"
              className={pathname.startsWith('/dashboard') ? styles.active : styles.link}
            >
              Mes ligues
            </Link>
          )}
          <Link
            href="/a-propos"
            className={pathname.startsWith('/a-propos') ? styles.active : styles.link}
          >
            À propos
          </Link>
        </nav>
      </div>
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
      </div>
    </header>
  );
}
