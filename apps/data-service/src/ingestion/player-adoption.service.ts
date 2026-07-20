import { Injectable, Logger } from '@nestjs/common';
import { GAME_IDS, GameId } from '@esfl/contracts';
import { pandascoreUpdate } from '../common/field-precedence';
import { PandascoreClient } from '../pandascore/pandascore.client';
import type { PSPlayer } from '../pandascore/pandascore.types';
import { PrismaService } from '../prisma.service';
import { normalizeName } from '../stats/matching';

/**
 * Graphies d'un pseudo à soumettre à Pandascore, dont la recherche par nom est
 * sensible à la casse. Trois formes couvrent l'essentiel des conventions
 * observées (« xyno », « Salazar », « MATYS ») sans faire exploser le nombre de
 * requêtes ; les doublons sont dédupliqués par l'appelant.
 */
export function nameVariants(name: string): string[] {
  const raw = name.trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  return [...new Set([raw, lower, capitalized])];
}

/** Bilan d'une passe d'adoption, remonté à l'admin. */
export interface AdoptionReport {
  orphelins: number;
  adoptes: number;
  fusionnes: number;
  ambigus: number;
  introuvables: number;
}

/**
 * Adoption des fiches joueur orphelines à l'échelle du jeu.
 *
 * Le sync des rosters ne rapproche un orphelin que du roster Pandascore de SON
 * équipe locale courante. Un joueur passé en académie, transféré, ou dont
 * l'équipe n'a plus de compétition active, est donc inatteignable à vie — d'où
 * une majorité de fiches sans `pandascoreId`. Cette passe interroge l'endpoint
 * `/players` par pseudo, sans contrainte d'équipe, et retrouve ces joueurs.
 *
 * Rapprochement strict : on n'adopte que si EXACTEMENT un joueur Pandascore
 * porte ce pseudo normalisé dans ce jeu. Jamais de best guess, même règle que
 * le rapprochement d'équipe ; les homonymes partent en file de validation.
 */
@Injectable()
export class PlayerAdoptionService {
  private readonly logger = new Logger(PlayerAdoptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pandascore: PandascoreClient,
  ) {}

  async adoptOrphans(): Promise<AdoptionReport> {
    const report: AdoptionReport = {
      orphelins: 0,
      adoptes: 0,
      fusionnes: 0,
      ambigus: 0,
      introuvables: 0,
    };
    if (!this.pandascore.enabled) {
      this.logger.warn('Adoption ignorée : PANDASCORE_TOKEN absent');
      return report;
    }

    for (const gameId of GAME_IDS) {
      const orphans = await this.prisma.player.findMany({
        where: { gameId, pandascoreId: null },
        select: { id: true, name: true, teamId: true, fieldSources: true },
      });
      if (orphans.length === 0) continue;
      report.orphelins += orphans.length;

      // `filter[name]` fait une égalité exacte, CASSE COMPRISE : demander
      // « Xyno » ne renvoie rien quand Pandascore stocke « xyno ». On envoie
      // donc plusieurs graphies du même pseudo ; le rapprochement final, lui,
      // reste strict sur la forme normalisée, donc élargir la requête n'élargit
      // jamais le critère d'adoption.
      const names = [...new Set(orphans.flatMap((player) => nameVariants(player.name)))];
      const found = await this.pandascore
        .listPlayersByNames(gameId as GameId, names)
        .catch((error) => {
          this.logger.warn(`Adoption ${gameId} : ${String(error)}`);
          return [] as PSPlayer[];
        });

      const byKey = new Map<string, PSPlayer[]>();
      for (const player of found) {
        const key = normalizeName(player.name);
        if (!key) continue;
        byKey.set(key, [...(byKey.get(key) ?? []), player]);
      }

      for (const orphan of orphans) {
        const candidates = byKey.get(normalizeName(orphan.name)) ?? [];
        if (candidates.length === 0) {
          report.introuvables += 1;
          continue;
        }
        if (candidates.length > 1) {
          await this.queueForReview(orphan.id, candidates);
          report.ambigus += 1;
          continue;
        }
        const outcome = await this.adoptOne(orphan, candidates[0]);
        if (outcome === 'fusion') report.fusionnes += 1;
        else if (outcome === 'adoption') report.adoptes += 1;
      }
    }

    this.logger.log(
      `Adoption : ${report.adoptes} adoptée(s), ${report.fusionnes} fusionnée(s), ` +
        `${report.ambigus} ambiguë(s), ${report.introuvables} introuvable(s) sur ${report.orphelins}`,
    );
    return report;
  }

  /**
   * Pose l'identité Pandascore sur l'orphelin. Si cet id est DÉJÀ porté par une
   * autre fiche locale, les deux fiches sont le même joueur (typiquement le
   * même pseudo sous deux équipes, principale et académie) : c'est un doublon
   * inter-équipes que seul Pandascore pouvait révéler, on fusionne.
   */
  private async adoptOne(
    orphan: { id: string; name: string; fieldSources: unknown },
    candidate: PSPlayer,
  ): Promise<'adoption' | 'fusion' | 'ignore'> {
    const holder = await this.prisma.player.findUnique({
      where: { pandascoreId: candidate.id },
      select: { id: true },
    });
    if (holder) {
      if (holder.id === orphan.id) return 'ignore';
      await this.mergeOrphanInto(holder.id, orphan.id);
      this.logger.log(`Doublon inter-équipes fusionné via Pandascore : ${orphan.name}`);
      return 'fusion';
    }

    // Précédence par champ : Pandascore ne remplit que ce qu'aucun provider ne
    // possède déjà (le pseudo publié par la source de stats fait foi).
    const data = pandascoreUpdate(
      {
        name: candidate.name,
        firstName: candidate.first_name,
        lastName: candidate.last_name,
        imageUrl: candidate.image_url,
        role: candidate.role,
        nationality: candidate.nationality,
      },
      orphan.fieldSources,
    );
    await this.prisma.player.update({
      where: { id: orphan.id },
      data: { ...data, pandascoreId: candidate.id },
    });
    return 'adoption';
  }

  /**
   * Rapatrie les stats de l'orphelin sur la fiche déjà identifiée puis le
   * supprime. Une ligne déjà présente sur la fiche gardée pour le même match
   * l'emporte : `@@unique([matchId, playerId])` ne tolère pas le doublon.
   */
  private async mergeOrphanInto(keepId: string, orphanId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const kept = await tx.playerMatchStats.findMany({
        where: { playerId: keepId },
        select: { matchId: true },
      });
      const keptMatches = new Set(kept.map((row) => row.matchId));
      const incoming = await tx.playerMatchStats.findMany({
        where: { playerId: orphanId },
        select: { id: true, matchId: true },
      });
      const conflicting = incoming.filter((row) => keptMatches.has(row.matchId)).map((r) => r.id);
      if (conflicting.length > 0) {
        await tx.playerMatchStats.deleteMany({ where: { id: { in: conflicting } } });
      }
      await tx.playerMatchStats.updateMany({
        where: { playerId: orphanId },
        data: { playerId: keepId },
      });
      await tx.playerAdoptionCandidate.deleteMany({ where: { playerId: orphanId } });
      await tx.player.delete({ where: { id: orphanId } });
    });
  }

  /** Mémorise les candidats d'un cas ambigu pour arbitrage dans la page admin. */
  private async queueForReview(playerId: string, candidates: PSPlayer[]): Promise<void> {
    const payload = candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      teamName: candidate.current_team?.name ?? null,
      role: candidate.role,
    }));
    await this.prisma.playerAdoptionCandidate.upsert({
      where: { playerId },
      create: { playerId, candidates: payload },
      update: { candidates: payload },
    });
  }

  /** Arbitrage admin : applique l'identité choisie et vide la file pour ce joueur. */
  async resolveAdoption(playerId: string, pandascoreId: number): Promise<{ merged: boolean }> {
    const orphan = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, fieldSources: true },
    });
    if (!orphan) throw new Error(`Fiche inconnue : ${playerId}`);
    const entry = await this.prisma.playerAdoptionCandidate.findUnique({ where: { playerId } });
    const candidates = (entry?.candidates ?? []) as Array<Record<string, unknown>>;
    const chosen = candidates.find((candidate) => candidate.id === pandascoreId);
    // On ne retient que ce que l'admin a réellement vu : un id saisi hors liste
    // n'est pas arbitré à l'aveugle.
    if (!chosen) throw new Error(`Candidat ${pandascoreId} absent de la liste proposée`);

    const outcome = await this.adoptOne(orphan, {
      id: pandascoreId,
      name: String(chosen.name ?? orphan.name),
      first_name: null,
      last_name: null,
      image_url: null,
      role: (chosen.role as string | null) ?? null,
      nationality: null,
      current_team: null,
    });
    await this.prisma.playerAdoptionCandidate.deleteMany({ where: { playerId } });
    return { merged: outcome === 'fusion' };
  }
}
