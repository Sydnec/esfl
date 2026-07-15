'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { Avatar } from './Avatar';
import { useAuth } from './AuthProvider';
import { Logo } from './Logo';
import styles from './Header.module.css';

export function Header() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <header className={styles.bar}>
      <div className={styles.header}>
        <div className={styles.left}>
          <Link href="/" className={styles.brand} aria-label="ESFL, accueil">
            <Logo />
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
            {user?.isAdmin && (
              <Link href="/admin" className={pathname === '/admin' ? styles.active : styles.link}>
                Admin
              </Link>
            )}
            {user?.isAdmin && (
              <Link
                href="/admin/stats"
                className={pathname.startsWith('/admin/stats') ? styles.active : styles.link}
              >
                Stats
              </Link>
            )}
          </nav>
        </div>
        <nav className={styles.nav}>
          {user ? (
            <>
              <Link href="/profil" className={styles.profileLink}>
                <Avatar
                  src={user.avatarUrl ? `${API_URL}${user.avatarUrl}` : null}
                  label={user.username}
                  size={24}
                />
                <span className={styles.username}>{user.username}</span>
              </Link>
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
