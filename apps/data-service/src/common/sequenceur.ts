/**
 * Sérialise les passages d'un traitement récurrent.
 *
 * Un scheduler BullMQ tire à intervalle fixe sans se soucier de la durée du
 * passage précédent, et le worker tourne à concurrency 5 : un cycle qui déborde
 * de sa cadence se retrouve doublé, puis triplé. Les sources externes voient
 * alors deux fois le débit prévu, ce que le throttle ne peut qu'étaler, donc
 * chaque cycle ralentit encore. La superposition s'auto-entretient.
 *
 * Ignorer le passage surnuméraire est le bon comportement pour un traitement
 * récurrent : le prochain tir reprendra l'état à jour. C'est ce qui permet de
 * serrer une cadence sans risque, un dépassement ne coûtant qu'un tir sauté.
 */
export class Sequenceur {
  private enCours = false;

  /**
   * Exécute `traitement`, sauf si un passage court déjà.
   *
   * `lance` est explicite plutôt qu'un `null` de retour : un traitement peut
   * légitimement rendre null, et l'appelant journaliserait alors « déjà en
   * cours » à tort.
   */
  async passer<T>(traitement: () => Promise<T>): Promise<{ lance: boolean; valeur?: T }> {
    if (this.enCours) return { lance: false };
    this.enCours = true;
    try {
      return { lance: true, valeur: await traitement() };
    } finally {
      this.enCours = false;
    }
  }
}
