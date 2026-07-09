import type { Metadata } from 'next';
import Link from 'next/link';
import { GAME_LABELS } from '@esfl/contracts';
import styles from './page.module.css';

export const metadata: Metadata = {
  title: 'Comment ça marche · ESFL',
};

export default function AboutPage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Comment ça marche</h1>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Le principe</h2>
        <p className={styles.text}>
          ESFL est une fantasy league esport <strong>multigaming</strong> qui se joue entre amis,
          en ligues privées. Chaque journée de match, tu composes un roster de joueurs
          professionnels issus des compétitions que ta ligue suit, tous jeux confondus, sans
          budget ni quota par jeu : trois joueurs de LoL et deux de CS2 dans le même roster,
          c&apos;est permis.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Le verrouillage</h2>
        <p className={styles.text}>
          La subtilité : une fois aligné, un joueur pro est <strong>verrouillé</strong> pendant
          les journées suivantes (configurable par ligue). Impossible de spammer la superstar
          tous les jours, il faut doser, anticiper le calendrier et connaître la profondeur des
          effectifs.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Les points</h2>
        <p className={styles.text}>
          Tes joueurs marquent des points selon leurs <strong>performances réelles</strong> :
          kills, assists, ACS, buts, saves… chaque jeu a son barème, calibré pour que les scores
          soient comparables entre jeux. Le classement se joue à l&apos;intérieur de ta ligue,
          journée après journée.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Les jeux suivis</h2>
        <ul className={styles.games}>
          {Object.entries(GAME_LABELS).map(([id, label]) => (
            <li key={id} className={styles.game}>
              {label}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Les ligues</h2>
        <p className={styles.text}>
          Crée ta ligue, choisis les compétitions à suivre (LEC, VCT, RLCS…), règle la taille du
          roster et la durée de verrouillage, puis partage le code d&apos;invitation. Le créateur
          peut ajouter des compétitions en cours de route quand une nouvelle saison démarre.
        </p>
        <p className={styles.text}>
          <Link href="/register">Créer un compte</Link> pour lancer ta première ligue.
        </p>
      </section>
    </main>
  );
}
