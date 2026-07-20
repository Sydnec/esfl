import { Injectable, Logger } from '@nestjs/common';
import { GAME_IDS, GameId } from '@esfl/contracts';
import { pandascoreUpdate } from '../common/field-precedence';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { LeaguepediaStatsProvider } from '../stats/leaguepedia.provider';
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

/**
 * Clé de comparaison d'un patronyme : tokens normalisés puis TRIÉS. L'ordre
 * prénom/nom varie d'une source à l'autre sur les noms coréens et chinois
 * (« Lee Sang-hyeok » chez Leaguepedia, « Lee » + « Sang-hyeok » chez
 * Pandascore, parfois inversés), et la ponctuation aussi. Chaîne vide quand la
 * source ne publie rien : deux inconnus ne se ressemblent jamais.
 */
export function realNameKey(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .split(/\s+/)
    .map((token) => normalizeName(token))
    .filter(Boolean)
    .sort()
    .join('|');
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
    private readonly leaguepedia: LeaguepediaStatsProvider,
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
        select: {
          id: true,
          name: true,
          teamId: true,
          fieldSources: true,
          providerIds: true,
          firstName: true,
          lastName: true,
          nationality: true,
        },
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

      // Patronyme des orphelins LoL encore inconnus : le sync des rosters ne
      // couvre que les titulaires actuels, or ce sont justement les anciens et
      // les académies qui restent ambigus. On les interroge par id provider.
      if (gameId === 'lol') await this.fillMissingIdentities(orphans);

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
        const resolved = candidates.length === 1 ? candidates : this.disambiguate(orphan, candidates);
        if (resolved.length === 0) {
          await this.queueForReview(orphan.id, candidates);
          report.ambigus += 1;
          continue;
        }
        // Plusieurs identités retenues = Pandascore se dédouble ; la première
        // devient l'identité principale, les autres des alias.
        const outcome = await this.adoptOne(orphan, resolved[0], resolved.slice(1).map((c) => c.id));
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
   * Complète patronyme et nationalité des orphelins LoL qui n'en ont pas, en
   * interrogeant Leaguepedia par pseudo canonique. Mute les objets en mémoire
   * pour que le départage qui suit en profite immédiatement.
   */
  private async fillMissingIdentities(
    orphans: Array<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      nationality: string | null;
      providerIds: unknown;
    }>,
  ): Promise<void> {
    const targets = orphans.filter((orphan) => !orphan.firstName && !orphan.lastName);
    const byProviderId = new Map<string, (typeof targets)[number]>();
    for (const orphan of targets) {
      const id = (orphan.providerIds as Record<string, string> | null)?.leaguepedia;
      if (id) byProviderId.set(id, orphan);
    }
    if (byProviderId.size === 0) return;

    const identities = await this.leaguepedia
      .fetchPlayerIdentities([...byProviderId.keys()])
      .catch((error) => {
        this.logger.warn(`Identités Leaguepedia : ${String(error)}`);
        return new Map<string, { realName: string | null; nationality: string | null }>();
      });

    for (const [providerId, identity] of identities) {
      const orphan = byProviderId.get(providerId);
      if (!orphan || !identity.realName) continue;
      const [firstName, ...rest] = identity.realName.trim().split(/\s+/);
      const data = {
        firstName: firstName || null,
        lastName: rest.length > 0 ? rest.join(' ') : null,
        nationality: orphan.nationality ?? identity.nationality,
      };
      await this.prisma.player.update({ where: { id: orphan.id }, data });
      Object.assign(orphan, data);
    }
    this.logger.log(`${identities.size} identité(s) Leaguepedia récupérée(s) pour départage`);
  }

  /**
   * Départage plusieurs joueurs Pandascore homonymes. Rend la liste des
   * identités à retenir : vide si le doute persiste (arbitrage humain), un
   * élément pour une adoption simple, plusieurs quand ce sont les identités
   * dupliquées d'une même personne.
   *
   * Trois critères, du plus au moins probant. Le pseudo ne discrimine rien ici
   * puisqu'il est identique par construction.
   */
  private disambiguate(
    orphan: { firstName: string | null; lastName: string | null; nationality: string | null },
    candidates: PSPlayer[],
  ): PSPlayer[] {
    // 1. Tous les candidats portent le même patronyme : ce n'est pas une
    //    ambiguïté mais un doublon chez Pandascore, on réunit les identités.
    const keys = candidates.map((c) => realNameKey(c.first_name, c.last_name));
    if (keys[0] && keys.every((key) => key === keys[0])) return candidates;

    // 2. Le patronyme de notre fiche (publié par Leaguepedia ou VLR) désigne
    //    exactement un candidat. Preuve la plus forte dont on dispose.
    const ours = realNameKey(orphan.firstName, orphan.lastName);
    if (ours) {
      const byName = candidates.filter((_, index) => keys[index] === ours);
      if (byName.length === 1) return byName;
      // Plusieurs candidats au même patronyme que le nôtre : encore un doublon
      // Pandascore, mais restreint à ceux qui nous correspondent.
      if (byName.length > 1) return byName;
    }

    // 3. À défaut, la nationalité. Bien plus faible qu'un patronyme (deux
    //    joueurs d'un même pays restent possibles), donc réservée au cas où
    //    elle isole UN seul candidat.
    const country = (orphan.nationality ?? '').toUpperCase();
    if (country) {
      const byCountry = candidates.filter(
        (candidate) => (candidate.nationality ?? '').toUpperCase() === country,
      );
      if (byCountry.length === 1) return byCountry;
    }

    return [];
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
    aliasIds: number[] = [],
  ): Promise<'adoption' | 'fusion' | 'ignore'> {
    // Toute identité du lot déjà portée localement désigne la même personne :
    // les deux fiches fusionnent, alias compris.
    const holder = await this.prisma.player.findFirst({
      where: {
        OR: [
          { pandascoreId: { in: [candidate.id, ...aliasIds] } },
          { pandascoreAliasIds: { hasSome: [candidate.id, ...aliasIds] } },
        ],
      },
      select: { id: true, pandascoreAliasIds: true },
    });
    if (holder) {
      if (holder.id === orphan.id) return 'ignore';
      await this.mergeOrphanInto(holder.id, orphan.id);
      const known = new Set([...holder.pandascoreAliasIds, ...aliasIds, candidate.id]);
      await this.prisma.player.update({
        where: { id: holder.id },
        data: { pandascoreAliasIds: [...known] },
      });
      this.logger.log(`Doublon fusionné via l'identité Pandascore : ${orphan.name}`);
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
      data: { ...data, pandascoreId: candidate.id, pandascoreAliasIds: aliasIds },
    });
    if (aliasIds.length > 0) {
      this.logger.log(
        `${orphan.name} : ${aliasIds.length + 1} identités Pandascore réunies (principale ${candidate.id})`,
      );
    }
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
      // Patronyme et nationalité affichés à l'admin : quand l'automatisme n'a
      // pas pu trancher (CS2 notamment, Grid ne nous donne pas le vrai nom),
      // c'est ce qui permet de décider sur pièces plutôt qu'au jugé.
      realName: [candidate.first_name, candidate.last_name].filter(Boolean).join(' ') || null,
      nationality: candidate.nationality,
    }));
    await this.prisma.playerAdoptionCandidate.upsert({
      where: { playerId },
      create: { playerId, candidates: payload },
      update: { candidates: payload },
    });
  }

  /**
   * Arbitrage admin. Accepte PLUSIEURS identités : quand Pandascore dédouble
   * une même personne, trancher ne consiste pas à choisir un candidat mais à
   * les réunir. La première devient l'identité principale, les suivantes des
   * alias — et toute fiche locale portant l'une d'elles est fusionnée.
   */
  async resolveAdoption(
    playerId: string,
    pandascoreIds: number[],
  ): Promise<{ merged: boolean; principale: number; alias: number[] }> {
    if (pandascoreIds.length === 0) throw new Error('Aucune identité choisie');
    const orphan = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, fieldSources: true },
    });
    if (!orphan) throw new Error(`Fiche inconnue : ${playerId}`);
    const entry = await this.prisma.playerAdoptionCandidate.findUnique({ where: { playerId } });
    const candidates = (entry?.candidates ?? []) as Array<Record<string, unknown>>;
    // On ne retient que ce que l'admin a réellement vu : un id saisi hors liste
    // n'est pas arbitré à l'aveugle.
    const chosen = pandascoreIds.map((id) => {
      const found = candidates.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`Candidat ${id} absent de la liste proposée`);
      return found;
    });

    const [principale, ...alias] = pandascoreIds;
    const outcome = await this.adoptOne(
      orphan,
      {
        id: principale,
        name: String(chosen[0].name ?? orphan.name),
        first_name: null,
        last_name: null,
        image_url: null,
        role: (chosen[0].role as string | null) ?? null,
        nationality: (chosen[0].nationality as string | null) ?? null,
        current_team: null,
      },
      alias,
    );
    await this.prisma.playerAdoptionCandidate.deleteMany({ where: { playerId } });
    return { merged: outcome === 'fusion', principale, alias };
  }
}
