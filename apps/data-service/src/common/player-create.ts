import { Prisma } from '../../generated/client';
import type { Player } from '../../generated/client';
import type { PrismaService } from '../prisma.service';
import { normalizeName } from '../stats/matching';

/**
 * Crée une fiche joueur en tolérant la course.
 *
 * Les deux chemins de création (ingestion des stats, application d'un roster)
 * vérifient l'absence du joueur sur un index chargé en mémoire au début du
 * job, jamais revalidé au moment du `create`. Avec un worker à concurrency 5,
 * deux jobs touchant la même équipe passent tous les deux la vérification et
 * créent la même fiche.
 *
 * L'index unique `players_game_team_name_key` fait maintenant échouer le
 * second (`P2002`) : on relit alors la fiche gagnante et on la renvoie, si
 * bien que l'appelant continue normalement avec une fiche valide. C'est la
 * seule façon fiable de fermer la fenêtre, un contrôle applicatif ne pouvant
 * pas être atomique entre plusieurs process.
 */
export async function createPlayerSafely(
  prisma: PrismaService,
  data: Prisma.PlayerUncheckedCreateInput,
): Promise<Player> {
  try {
    return await prisma.player.create({ data });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const existing = await findPlayerByNameKey(prisma, data.gameId, data.teamId ?? null, data.name);
    // Course perdue mais fiche introuvable : l'index a sauté sur un autre
    // critère, on laisse remonter plutôt que d'inventer une fiche.
    if (!existing) throw error;
    return existing;
  }
}

/**
 * Fiche d'une équipe dont le pseudo normalisé correspond. Passe par une
 * requête brute : l'unicité vit dans un index d'expression que Prisma ne
 * connaît pas, donc `findUnique` n'est pas utilisable dessus.
 */
async function findPlayerByNameKey(
  prisma: PrismaService,
  gameId: string,
  teamId: string | null,
  name: string,
): Promise<Player | null> {
  const key = normalizeName(name);
  if (!key || !teamId) return null;
  const rows = await prisma.$queryRaw<Player[]>`
    SELECT * FROM "players"
    WHERE "game_id" = ${gameId}
      AND "team_id" = ${teamId}
      AND lower(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g')) = ${key}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
