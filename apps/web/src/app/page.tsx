import { HomeCta } from '@/components/HomeCta';
import { MatchesOverview } from '@/components/MatchesOverview';
import styles from './page.module.css';

export default function HomePage() {
  return (
    <main className={styles.main}>
      <HomeCta />
      <MatchesOverview />
    </main>
  );
}
