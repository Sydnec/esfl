import { GAME_LABELS } from '@esfl/contracts';
import styles from './page.module.css';

export default function HomePage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>ESFL</h1>
      <p className={styles.subtitle}>Esport Fantasy League multigaming</p>
      <ul className={styles.games}>
        {Object.entries(GAME_LABELS).map(([id, label]) => (
          <li key={id} className={styles.game}>
            {label}
          </li>
        ))}
      </ul>
    </main>
  );
}
