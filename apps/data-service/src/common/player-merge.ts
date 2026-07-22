import { Prisma } from '../../generated/client';

/** Transaction Prisma (le client passé dans `$transaction`). */
type Tx = Prisma.TransactionClient;

/**
 * Rapatrie les lignes de stats de plusieurs fiches absorbées vers la fiche
 * gardée. Mutualisé entre la fusion des doublons (catalog) et l'adoption
 * (player-adoption) : sans ça, deux transactions divergeraient silencieusement
 * sur un même invariant.
 *
 * Contrainte gérée : `@@unique([matchId, playerId])` interdit deux lignes du
 * même joueur sur un match. Quand la fiche gardée a déjà une ligne pour un
 * match qu'une fiche absorbée couvre aussi, la ligne de l'absorbée est
 * supprimée (celle de la gardée fait foi) avant le rattachement en masse.
 *
 * Ne supprime PAS les fiches absorbées : chaque appelant le fait après ses
 * propres fusions de champs (providerIds, alias…), dans la même transaction.
 *
 * Les notes fantasy vivent dans un AUTRE schéma, sans clé étrangère possible :
 * rien ne les suit automatiquement. C'est à l'appelant de les faire transférer
 * (`ScoringClient.playersMerged`), sans quoi elles restent accrochées à une
 * fiche supprimée et la fiche gardée perd son historique.
 */
export async function reassignPlayerStats(
  tx: Tx,
  keepId: string,
  absorbedIds: string[],
): Promise<void> {
  if (absorbedIds.length === 0) return;
  const kept = await tx.playerMatchStats.findMany({
    where: { playerId: keepId },
    select: { matchId: true },
  });
  const keptMatches = new Set(kept.map((row) => row.matchId));
  const incoming = await tx.playerMatchStats.findMany({
    where: { playerId: { in: absorbedIds } },
    select: { id: true, matchId: true },
  });
  const conflicting = incoming.filter((row) => keptMatches.has(row.matchId)).map((row) => row.id);
  if (conflicting.length > 0) {
    await tx.playerMatchStats.deleteMany({ where: { id: { in: conflicting } } });
  }
  await tx.playerMatchStats.updateMany({
    where: { playerId: { in: absorbedIds } },
    data: { playerId: keepId },
  });
}
