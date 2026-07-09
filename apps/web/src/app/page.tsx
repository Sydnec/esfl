import { GAME_LABELS } from '@esfl/contracts';
import { HomeCta } from '@/components/HomeCta';
import { MatchesOverview } from '@/components/MatchesOverview';
import styles from './page.module.css';

export default function HomePage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>ESFL</h1>
      <p className={styles.subtitle}>
        La fantasy league esport multigaming entre amis. Compose ton roster chaque journée de
        match, tes joueurs marquent des points selon leurs vraies performances — mais une fois
        alignés, ils sont verrouillés pour les journées suivantes.
      </p>
      <ul className={styles.games}>
        {Object.entries(GAME_LABELS).map(([id, label]) => (
          <li key={id} className={styles.game}>
            {label}
          </li>
        ))}
      </ul>
      <HomeCta />
      <MatchesOverview />
    </main>
  );
}
