import { Injectable, Logger } from '@nestjs/common';
import type { Team } from '../../generated/client';
import { providerUpdate } from '../common/field-precedence';
import { normalizeName } from '../stats/matching';
import { LeaguepediaStatsProvider } from '../stats/leaguepedia.provider';
import { VlrStatsProvider } from '../stats/vlr.provider';
import type { GameStatsProvider } from '../stats/provider';
import { PrismaService } from '../prisma.service';
import { IngestionService } from './ingestion.service';

/**
 * Enrichissement d'une équipe depuis sa source spécialisée : le provider est
 * source de vérité sur les métadonnées (nom, tag, logo, pays), Pandascore
 * n'est qu'un fallback. Déclenché à la création de l'équipe (recherche
 * proactive par nom) et à chaque id provider appris depuis un match résolu.
 */
@Injectable()
export class TeamEnrichmentService {
  private readonly logger = new Logger(TeamEnrichmentService.name);
  /** Sources d'enrichissement par jeu (Grid/ballchasing n'exposent pas de fiche équipe). */
  private readonly providers: GameStatsProvider[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    vlr: VlrStatsProvider,
    leaguepedia: LeaguepediaStatsProvider,
  ) {
    this.providers = [vlr, leaguepedia];
  }

  async enrichTeam(teamId: string): Promise<void> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) return;
    const provider = this.providers.find((candidate) => candidate.gameId === team.gameId);
    if (!provider?.fetchTeamProfile) return;

    // Identité provider : déjà apprise (match résolu, enrichissement passé),
    // sinon recherche proactive stricte — l'ambigu attend un match résolu.
    const providerIds = (team.providerIds as Record<string, string> | null) ?? {};
    let providerTeamId = providerIds[provider.source] ?? null;
    if (!providerTeamId && provider.searchTeam) {
      const found = await provider.searchTeam(team.name, team.aliases ?? [], team.acronym);
      if (!found) {
        this.logger.log(
          `Enrichissement ${team.name} : introuvable/ambigu chez ${provider.source}, on attend un match résolu`,
        );
        return;
      }
      providerTeamId = found.id;
      await this.prisma.team.update({
        where: { id: team.id },
        data: { providerIds: { ...providerIds, [provider.source]: found.id } },
      });
      this.logger.log(
        `Id ${provider.source} résolu par recherche : ${team.name} → ${found.id}`,
      );
    }
    if (!providerTeamId) return;

    const profile = await provider.fetchTeamProfile(providerTeamId);
    if (!profile) {
      this.logger.warn(`Fiche ${provider.source} indisponible pour ${team.name}`);
      return;
    }

    // Provider = source de vérité sur nom/tag/pays. Le LOGO reste Pandascore
    // pour toutes les équipes : cadrage carré fiable, quand les providers
    // mélangent bannières (Leaguepedia « logo profile ») et formats variables.
    const { data, fieldSources } = providerUpdate(
      {
        name: profile.name ?? null,
        acronym: profile.acronym ?? null,
        location: profile.location ?? null,
      },
      provider.source,
      team.fieldSources,
    );
    // Logo revendiqué par un enrichissement antérieur : on libère le champ,
    // Pandascore le re-remplit au prochain sync.
    if (fieldSources.imageUrl) {
      delete fieldSources.imageUrl;
      (data as Record<string, unknown>).imageUrl = null;
    }
    // Garde-fou anti-vol d'identité : si la fiche récupérée porte le nom d'une
    // AUTRE équipe connue, la résolution est suspecte (mauvaise page) — on
    // n'applique rien et on nettoie l'id appris par recherche.
    if (typeof data.name === 'string' && (await this.isOtherKnownTeam(team, data.name))) {
      this.logger.warn(
        `Enrichissement ${team.name} : la fiche ${provider.source} « ${data.name} » ressemble à une autre équipe connue, abandon`,
      );
      return;
    }
    // Le nom Pandascore reste utile au matching par nom (Grid, ballchasing…) :
    // s'il est remplacé, on le garde en alias.
    const aliases = [...(team.aliases ?? [])];
    if (
      typeof data.name === 'string' &&
      normalizeName(data.name) !== normalizeName(team.name) &&
      !aliases.some((alias) => normalizeName(alias) === normalizeName(team.name))
    ) {
      aliases.push(team.name);
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.team.update({
        where: { id: team.id },
        data: { ...data, fieldSources, aliases },
      });
      this.logger.log(
        `Équipe ${team.name} enrichie via ${provider.source} (${Object.keys(data).join(', ')})`,
      );
    }

    // Roster lu au passage : peuple les joueurs avant le premier match ingéré.
    if (profile.roster?.length) {
      const fresh = await this.prisma.team.findUnique({ where: { id: team.id } });
      await this.ingestion.applyStarterRoster(fresh ?? team, profile.roster);
    }
  }

  /**
   * Vrai si le nom appartient déjà exactement à une autre équipe du même jeu
   * (anti-vol d'identité). Égalité exacte uniquement : l'inclusion floue
   * bloquerait des enrichissements légitimes — « T1 » « ressemble » à
   * « T1 Academy » sans être elle, et le vrai T1 resterait figé sous un
   * mauvais nom.
   */
  private async isOtherKnownTeam(team: Team, name: string): Promise<boolean> {
    const normalized = normalizeName(name);
    const teams = await this.prisma.team.findMany({
      where: { gameId: team.gameId, id: { not: team.id } },
      select: { name: true, aliases: true },
    });
    return teams.some(
      (other) =>
        normalizeName(other.name) === normalized ||
        (other.aliases ?? []).some((alias) => normalizeName(alias) === normalized),
    );
  }
}
