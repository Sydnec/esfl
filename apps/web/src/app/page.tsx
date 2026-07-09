import Link from 'next/link';
import { HomeCta } from '@/components/HomeCta';
import { MatchesOverview } from '@/components/MatchesOverview';
import styles from './page.module.css';

export default function HomePage() {
  return (
    <main className={styles.main}>
      <div className={styles.hero}>
        <h1 className={styles.title}>ESFL</h1>
        <p className={styles.tagline}>
          La fantasy league esport entre amis.{' '}
          <Link href="/a-propos">Comment ça marche&nbsp;→</Link>
        </p>
      </div>
      <HomeCta />
      <MatchesOverview />
    </main>
  );
}
