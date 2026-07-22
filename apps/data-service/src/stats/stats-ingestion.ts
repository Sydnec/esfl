import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { GameId, QUEUES, StatsIngestedEvent } from '@esfl/contracts';
import { Queue } from 'bullmq';
import { Prisma } from '../../generated/client';
import type { Match, Player, Team } from '../../generated/client';
import { AlerteService } from '../common/alerte.service';
import { providerUpdate } from '../common/field-precedence';
import { createPlayerSafely } from '../common/player-create';
import { mergeGamesSummary } from '../common/games-summary';
import { enqueueEnrichTeam, INGESTION_QUEUE } from '../ingestion/ingestion.constants';
import { LiveEventsService } from '../live/live-events.service';
import { PrismaService } from '../prisma.service';
import { buildPlayerIndex, matchPlayer, normalizeName, teamMatches } from './matching';
import type { NamedPlayer } from './matching';
import { Bo3StatsProvider } from './bo3.provider';
import { LeaguepediaStatsProvider } from './leaguepedia.provider';
import type {
  GameStatsProvider,
  MatchContext,
  ProviderGameInfo,
  ProviderResult,
  TeamProfile,
} from './provider';
import { VlrStatsProvider } from './vlr.provider';

/** Taille d'un alignement : CS2, Valorant et LoL sont tous en 5v5. */
const LINEUP_SIZE = 5;

/** Slug d'un lien lol.fandom.com/wiki/... ; null si ce n'est pas un tel lien. */
function leaguepediaSlug(input: string): string | null {
  const trimmed = input.trim();
  if (!/lol\.fandom\.com\/wiki\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return url.pathname.split('/wiki/')[1] || null;
  } catch {
    return null;
  }
}

@Injectable()
export class StatsIngestionService {
  private readonly logger = new Logger(StatsIngestionService.name);
  private readonly providers: GameStatsProvider[];

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.STATS_INGESTED) private readonly statsIngestedQueue: Queue,
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
    private readonly liveEvents: LiveEventsService,
    private readonly alertes: AlerteService,
    private readonly bo3: Bo3StatsProvider,
    vlr: VlrStatsProvider,
    private readonly leaguepedia: LeaguepediaStatsProvider,
  ) {
    this.providers = [bo3, vlr, leaguepedia];
  }

  /**
   * Noms fiables d'une équipe LoL à partir d'une saisie admin : si c'est un
   * lien lol.fandom.com, on résout le nom canonique + variantes via Leaguepedia
   * (redirections, renommages, formes courtes). Liste vide si ce n'est pas un
   * lien Leaguepedia — l'appelant utilise alors la saisie telle quelle.
   */
  async resolveLeaguepediaNames(input: string): Promise<string[]> {
    const slug = leaguepediaSlug(input);
    if (!slug) return [];
    const name = decodeURIComponent(slug).replace(/_/g, ' ').trim();
    if (!name) return [];
    const resolved = await this.leaguepedia.resolveTeamNames(name);
    // Au pire (requête en échec) on garde au moins le nom tiré du lien.
    return resolved.length > 0 ? resolved : [name];
  }

  /**
   * Résout une saisie admin (lien provider ou id brut) en identité provider
   * pour une équipe, et la VALIDE en tapant la fiche : on ne persiste jamais un
   * id que la source ne reconnaît pas. Les formes acceptées suivent l'id de
   * chaque source — Leaguepedia : nom canonique de la page (lien
   * lol.fandom.com/wiki/... ou nom) ; VLR : id numérique (lien vlr.gg/team/... ou
   * nombre). Lève si le jeu n'a pas de fiche équipe ou si la saisie
   * ne correspond à rien chez la source.
   */
  async resolveTeamProviderId(
    team: Team,
    input: string,
  ): Promise<{ source: string; providerTeamId: string; profile: TeamProfile }> {
    const raw = input.trim();
    if (!raw) throw new BadRequestException('Identifiant provider vide');
    const provider = this.providers.find((candidate) => candidate.gameId === team.gameId);
    if (!provider?.fetchTeamProfile) {
      throw new BadRequestException(
        `Aucune fiche équipe chez la source de ${team.gameId} : id provider non saisissable`,
      );
    }

    let providerTeamId: string;
    if (provider.source === 'leaguepedia') {
      // L'id Leaguepedia EST le nom canonique de la page d'overview : on passe
      // par la résolution des redirections pour qu'un nom d'usage ou un lien
      // vers une redirection retombe sur la bonne page.
      const fromLink = leaguepediaSlug(raw);
      const name = fromLink ? decodeURIComponent(fromLink).replace(/_/g, ' ').trim() : raw;
      const resolved = await this.leaguepedia.resolveTeamNames(name);
      providerTeamId = resolved[0] ?? name;
    } else {
      // VLR et bo3 : id numérique, dans un lien /team(s)/<id>/... ou saisi brut.
      const id = raw.match(/\/teams?\/(\d+)/)?.[1] ?? (/^\d+$/.test(raw) ? raw : null);
      if (!id) {
        throw new BadRequestException(
          `Id numérique attendu chez ${provider.source} (lien vers la page équipe ou nombre), reçu « ${raw} »`,
        );
      }
      providerTeamId = id;
    }

    const profile = await provider.fetchTeamProfile(providerTeamId);
    if (!profile) {
      throw new BadRequestException(
        `${provider.source} ne connaît pas « ${providerTeamId} » : rien n'a été enregistré`,
      );
    }
    return { source: provider.source, providerTeamId, profile };
  }

  /**
   * Récupère les stats détaillées d'un match terminé et publie stats.ingested.
   * Lève si les stats ne sont pas encore publiées par la source externe :
   * le job BullMQ `ingest-stats` retentera avec backoff exponentiel.
   * `force` refait le fetch même si des stats existent (backfill du détail
   * par map, correction de données).
   */
  async ingestForMatchId(matchId: string, force = false): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) {
      this.logger.warn(`ingest-stats : match inconnu ${matchId}`);
      return;
    }

    if (!force) {
      const newest = await this.prisma.playerMatchStats.aggregate({
        _max: { updatedAt: true },
        where: { matchId },
      });
      const newestAt = newest._max.updatedAt;
      // Un instantané pris pendant le match (sync live) est antérieur au
      // coup de sifflet : on refait le fetch pour figer les stats finales.
      const liveSnapshot = newestAt && match.endAt && newestAt < match.endAt;
      if (newestAt && !liveSnapshot) {
        await this.publish(match, 'existing');
        return;
      }
    }

    const provider = this.providers.find((candidate) => candidate.gameId === match.gameId);
    if (!provider) {
      this.logger.warn(`Aucun provider de stats pour ${match.gameId} (${match.name})`);
      return;
    }

    const context = await this.loadContext(match);
    const result = await provider.fetchStats(match, context);
    if (!result || result.lines.length === 0) {
      await this.recordFailureDiagnosis(match, context, provider, force);
      // Un parser cassé ne lève rien : il rend zéro ligne. Seule la répétition
      // le distingue des matchs qu'une source ne référence pas.
      await this.alertes.echec(provider.source, `aucune stat pour ${match.name}`);
      throw new Error(
        `Stats indisponibles pour le match ${match.name} via ${provider.source}, nouvelle tentative planifiée`,
      );
    }
    this.alertes.succes(provider.source);

    const persisted = await this.persistResult(match, context, provider.source, result);
    // Succès : on efface un éventuel diagnostic d'échec précédent.
    if (match.statsFailureKind) {
      await this.prisma.match.update({
        where: { id: match.id },
        data: { statsFailureKind: null, statsSuggestion: Prisma.DbNull },
      });
    }
    this.logger.log(`${persisted} lignes de stats ${provider.source} pour ${match.name}`);
    await this.publish(match, provider.source);
  }

  /**
   * Qualifie un échec d'ingestion pour ne surfacer côté admin que les vrais
   * problèmes de nom : si la source expose une affiche où une seule des deux
   * équipes est reconnue (candidats de `suggestTeamNames`), c'est un
   * name-mismatch (le nom candidat est mémorisé pour le pré-remplissage) ;
   * sinon la source n'a pas le match → no-coverage. Réutilise la fenêtre déjà
   * récupérée par le provider, sans appel externe dédié côté ingestion.
   * Ne diagnostique qu'une fois par chaîne d'échec (borne le coût des retries).
   */
  private async recordFailureDiagnosis(
    match: Match,
    context: MatchContext,
    provider: GameStatsProvider,
    force = false,
  ): Promise<void> {
    // Déjà diagnostiqué : on ne recalcule qu'à la relance manuelle (force).
    if (match.statsFailureKind && !force) return;
    let kind = 'no-coverage';
    let suggestion: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
    if (provider.suggestTeamNames && context.teamA && context.teamB) {
      const candidates = await provider.suggestTeamNames(match, context).catch(() => []);
      if (candidates.length > 0) {
        kind = 'name-mismatch';
        suggestion = candidates as unknown as Prisma.InputJsonValue;
      }
    }
    await this.prisma.match.update({
      where: { id: match.id },
      data: { statsFailureKind: kind, statsSuggestion: suggestion },
    });
  }

  /**
   * Suivi des matchs en cours pour les jeux dont le provider expose
   * fetchLiveStats (page VLR vivante) : resynchronisés
   * à chaque cycle pour offrir le même affichage qu'un match terminé.
   * Sans retry : le cycle suivant repassera.
   */
  async syncLiveStats(): Promise<number> {
    let synced = 0;
    for (const provider of this.providers) {
      if (!provider.fetchLiveStats) continue;
      const running = await this.prisma.match.findMany({
        where: {
          gameId: provider.gameId,
          status: 'running',
          teamAId: { not: null },
          teamBId: { not: null },
        },
      });
      for (const match of running) {
        const context = await this.loadContext(match);
        const result = await provider.fetchLiveStats(match, context).catch(() => null);
        if (!result || result.lines.length === 0) continue;
        await this.persistResult(match, context, provider.source, result);
        await this.publish(match, provider.source);
        synced += 1;
      }
    }
    if (synced > 0) {
      this.logger.log(`Stats live synchronisées pour ${synced} match(s)`);
    }
    return synced;
  }

  /**
   * Persiste un résultat provider : résolution d'identité (exact → leet →
   * inclusion, sinon création de la fiche quand le côté du joueur est connu
   * — le référentiel Pandascore est lacunaire sur les équipes tier-B, le
   * sync des rosters adoptera la fiche s'il rattrape), upsert des stats,
   * fusion des manches et mémorisation de la page source.
   */
  private async persistResult(
    match: Match,
    context: MatchContext,
    source: string,
    result: ProviderResult,
  ): Promise<number> {
    const index = buildPlayerIndex(context.players);
    // Index par id provider (VLR) : rapprochement fiable au-delà du pseudo.
    const byProviderId = new Map<string, NamedPlayer>();
    const providerIdsByPlayer = new Map<string, Record<string, string>>();
    // Fiches complètes par id : rôle/fieldSources accessibles après résolution.
    const playersById = new Map<string, Player>(context.players.map((p) => [p.id, p]));
    for (const player of context.players) {
      const ids = (player.providerIds as Record<string, string> | null) ?? {};
      providerIdsByPlayer.set(player.id, ids);
      if (ids[source]) byProviderId.set(ids[source], player);
    }
    // Résolution une seule fois : id provider d'abord, sinon rapprochement par pseudo.
    const resolved = result.lines.map((line) => ({
      line,
      local:
        (line.externalId ? byProviderId.get(line.externalId) : undefined) ??
        matchPlayer(index, line.externalName),
    }));
    // Côté local (A/B) de chaque équipe source — via le côté résolu par le
    // provider (nom), sinon via les joueurs. Robuste même quand les deux noms
    // d'équipe diffèrent des nôtres (cas VCT China).
    const sideByTeam = this.sourceTeamSides(resolved, context);

    // Garde « les joueurs collent » (règle 4 du rapprochement) : quand une
    // équipe a déjà un roster connu (≥ 3 fiches) et qu'AUCUN de ses joueurs ne
    // se résout dans les lignes de son côté, le rattachement est suspect
    // (alias volé, mauvaise page d'un matchup répété) — on n'enregistre rien,
    // le retry/diagnostic et le matching manuel prennent le relais.
    const sideOf = (line: ProviderResult['lines'][number]) =>
      line.side ?? (line.teamName ? sideByTeam.get(line.teamName.trim()) ?? null : null);
    for (const side of ['A', 'B'] as const) {
      const team = side === 'A' ? context.teamA : context.teamB;
      if (!team) continue;
      const knownIds = new Set(
        context.players.filter((player) => player.teamId === team.id).map((player) => player.id),
      );
      if (knownIds.size < 3) continue;
      const sideLines = resolved.filter(({ line }) => sideOf(line) === side);
      if (sideLines.length === 0) continue;
      const confirmed = sideLines.some(({ local }) => local && knownIds.has(local.id));
      if (!confirmed) {
        throw new Error(
          `Stats ${source} rejetées pour ${match.name} : aucun joueur connu de ${team.name} ` +
            `parmi les lignes récupérées — rattachement suspect, rien n'est enregistré`,
        );
      }
    }

    let persisted = 0;
    // Lineup résolu par côté : devient le roster courant de l'équipe (le lien
    // joueur-équipe suit le dernier match connu).
    const lineupBySide = new Map<'A' | 'B', Set<string>>([
      ['A', new Set()],
      ['B', new Set()],
    ]);
    for (const { line, local: existing } of resolved) {
      const side =
        line.side ?? (line.teamName ? sideByTeam.get(line.teamName.trim()) ?? null : null);
      let local = existing;
      if (!local) {
        const team = side === 'A' ? context.teamA : side === 'B' ? context.teamB : null;
        if (!team) {
          this.logger.warn(
            `Joueur ${line.externalName} sans équipe résolue (${match.name}) : stats ignorées`,
          );
          continue;
        }
        // Vrai nom civil (bo3) : éclaté prénom/nom au modèle Pandascore.
        const [firstName, ...rest] = (line.realName ?? '').trim().split(/\s+/);
        const lastName = rest.length > 0 ? rest.join(' ') : null;
        // Création tolérante à la course : un job concurrent sur la même
        // équipe peut avoir créé la fiche depuis le chargement de l'index.
        const created = await createPlayerSafely(this.prisma, {
          gameId: match.gameId,
          name: line.externalName,
          teamId: team.id,
          role: line.role ?? null,
          firstName: firstName || null,
          lastName,
          nationality: line.nationality ?? null,
          source,
          providerIds: line.externalId ? { [source]: line.externalId } : undefined,
          // Champs posés par le provider : possédés d'entrée (Pandascore ne
          // fera que compléter les manquants à l'adoption).
          fieldSources: {
            name: source,
            ...(line.role ? { role: source } : {}),
            ...(firstName ? { firstName: source, lastName: source } : {}),
            ...(line.nationality ? { nationality: source } : {}),
          },
        });
        local = created;
        playersById.set(created.id, created);
        index.set(normalizeName(created.name), created);
        if (line.externalId) providerIdsByPlayer.set(created.id, { [source]: line.externalId });
        this.logger.log(`Fiche joueur créée depuis ${source} : ${line.externalName} (${team.name})`);
      }
      // Apprend l'id provider du joueur résolu (fiabilise les prochains matchings).
      if (line.externalId) {
        const known = providerIdsByPlayer.get(local.id) ?? {};
        if (known[source] !== line.externalId) {
          const next = { ...known, [source]: line.externalId };
          await this.prisma.player.update({ where: { id: local.id }, data: { providerIds: next } });
          providerIdsByPlayer.set(local.id, next);
        }
      }
      // « Dernier rôle connu » : le rôle réellement joué sur ce match met à
      // jour la fiche (un mid passé ADC est reflété dès le match suivant).
      const full = playersById.get(local.id);
      if (line.role && full && full.role !== line.role) {
        const { data, fieldSources } = providerUpdate(
          { role: line.role },
          source,
          full.fieldSources,
        );
        await this.prisma.player.update({
          where: { id: local.id },
          data: { ...data, fieldSources },
        });
        full.role = line.role;
        full.fieldSources = fieldSources;
      }
      // Identité civile publiée par la source (bo3) : complète une fiche qui ne
      // l'a pas encore (précédence par champ ; ne réécrit pas ce que Pandascore
      // ou une autre source possède déjà).
      if (full && (line.realName || line.nationality)) {
        const [firstName, ...rest] = (line.realName ?? '').trim().split(/\s+/);
        const { data, fieldSources } = providerUpdate(
          {
            ...(firstName ? { firstName, lastName: rest.join(' ') || null } : {}),
            ...(line.nationality ? { nationality: line.nationality } : {}),
          },
          source,
          full.fieldSources,
        );
        if (Object.keys(data).length > 0) {
          await this.prisma.player.update({ where: { id: local.id }, data: { ...data, fieldSources } });
          full.fieldSources = fieldSources;
        }
      }
      await this.prisma.playerMatchStats.upsert({
        where: { matchId_playerId: { matchId: match.id, playerId: local.id } },
        create: {
          matchId: match.id,
          playerId: local.id,
          gameId: match.gameId,
          source,
          raw: line.raw,
          normalized: line.normalized,
          perMap: line.perMap ?? Prisma.JsonNull,
          // Snapshot au moment T : pseudo publié, rôle joué, côté — copies,
          // pas des liens (un renommage/transfert ne réécrit pas l'histoire).
          playerName: line.externalName,
          role: line.role ?? null,
          teamSide: side,
        },
        update: {
          raw: line.raw,
          normalized: line.normalized,
          source,
          perMap: line.perMap ?? Prisma.JsonNull,
          playerName: line.externalName,
          // Un provider muet sur le rôle n'efface pas un snapshot déjà posé.
          ...(line.role ? { role: line.role } : {}),
          teamSide: side,
        },
      });
      if (side) lineupBySide.get(side)?.add(local.id);
      persisted += 1;
    }
    if (result.games?.length) {
      await this.mergeProviderGames(match, result.games, sideByTeam);
    }
    // Snapshot des équipes au moment de l'ingestion ({ name, acronym }, pas de
    // logo — trop lourd dans le temps) : rafraîchi à chaque ingestion, la
    // dernière est la vérité du moment T.
    const matchUpdate: Prisma.MatchUpdateInput = {};
    if (context.teamA) {
      matchUpdate.teamASnapshot = { name: context.teamA.name, acronym: context.teamA.acronym };
    }
    if (context.teamB) {
      matchUpdate.teamBSnapshot = { name: context.teamB.name, acronym: context.teamB.acronym };
    }
    if (result.pageUrl && result.pageUrl !== match.statsPageUrl) {
      matchUpdate.statsPageUrl = result.pageUrl;
    }
    if (Object.keys(matchUpdate).length > 0) {
      await this.prisma.match.update({ where: { id: match.id }, data: matchUpdate });
    }
    await this.learnSourceAliases(match, context, source, sideByTeam);
    // Id de l'équipe chez la source, appris depuis ce match résolu : persistant
    // et fiable (les deux équipes reconnues) → sert à taper la bonne page
    // équipe pour les rosters sans recherche par nom.
    if (result.teamIds) {
      await this.saveProviderTeamId(context.teamA, source, result.teamIds.A);
      await this.saveProviderTeamId(context.teamB, source, result.teamIds.B);
    }
    await this.applyMatchRoster(match, context, lineupBySide);
    await this.purgeStaleStats(match, lineupBySide);
    return persisted;
  }

  /**
   * Supprime les lignes de stats que le provider n'émet plus. Les stats sont
   * upsertées : sans ça, une ligne fantôme écrite une fois (remplaçant listé
   * dans un lineup, observateur d'une game vide) survit indéfiniment, même une
   * fois le filtre du provider corrigé — d'où des matchs à 11 joueurs dont un
   * à 0/0/0.
   *
   * Garde-fou : on ne purge que si les DEUX côtés sont revenus complets
   * (5 joueurs résolus chacun, tous les jeux du périmètre sont en 5v5). Une
   * page partielle (live en cours, scrape tronqué) ne doit jamais effacer des
   * stats déjà correctes.
   */
  private async purgeStaleStats(
    match: Match,
    lineupBySide: Map<'A' | 'B', Set<string>>,
  ): Promise<void> {
    const sideA = lineupBySide.get('A') ?? new Set<string>();
    const sideB = lineupBySide.get('B') ?? new Set<string>();
    if (sideA.size < LINEUP_SIZE || sideB.size < LINEUP_SIZE) return;
    const keep = [...sideA, ...sideB];
    const { count } = await this.prisma.playerMatchStats.deleteMany({
      where: { matchId: match.id, playerId: { notIn: keep } },
    });
    if (count > 0) {
      this.logger.log(`${count} ligne(s) de stats obsolète(s) supprimée(s) sur ${match.name}`);
    }
  }

  /**
   * Le lineup de ce match devient le roster courant de chaque équipe résolue :
   * teamId déplacé (un transfert se règle au match suivant), alignés actifs,
   * autres joueurs de l'équipe désactivés. Garde-fous : au moins 3 joueurs
   * résolus (page partielle ignorée) et date du match ≥ dernier roster appliqué
   * (un backfill de vieux match ne régresse pas le roster courant). S'applique
   * aussi aux stats live (le lineup du soir est par définition le plus récent).
   */
  private async applyMatchRoster(
    match: Match,
    context: MatchContext,
    lineupBySide: Map<'A' | 'B', Set<string>>,
  ): Promise<void> {
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return;
    for (const side of ['A', 'B'] as const) {
      const team = side === 'A' ? context.teamA : context.teamB;
      const lineup = lineupBySide.get(side) ?? new Set<string>();
      if (!team || lineup.size < 3) continue;
      if (team.rosterSyncedAt && reference < team.rosterSyncedAt) continue;
      const ids = [...lineup];
      await this.prisma.player.updateMany({
        where: { id: { in: ids } },
        data: { teamId: team.id, active: true },
      });
      await this.prisma.player.updateMany({
        where: { teamId: team.id, id: { notIn: ids } },
        data: { active: false },
      });
      await this.prisma.team.update({
        where: { id: team.id },
        data: { rosterSyncedAt: reference },
      });
      team.rosterSyncedAt = reference;
    }
  }

  /** Écrit `Team.providerIds[source]` (fusion), en mémoire et en base. */
  private async saveProviderTeamId(
    team: MatchContext['teamA'],
    source: string,
    id: string | null | undefined,
  ): Promise<void> {
    if (!team || !id) return;
    const current = (team.providerIds as Record<string, string> | null) ?? {};
    if (current[source] === id) return;
    const next = { ...current, [source]: id };
    await this.prisma.team.update({ where: { id: team.id }, data: { providerIds: next } });
    team.providerIds = next;
    // Identité provider fraîchement apprise : l'enrichissement (nom, tag,
    // logo… — provider source de vérité) peut maintenant se déclencher.
    await enqueueEnrichTeam(this.ingestionQueue, team.id).catch((error) =>
      this.logger.warn(`enqueue enrich-team ${team.id} : ${String(error)}`),
    );
  }

  /**
   * Côté local (A/B) de chaque nom d'équipe source, déduit des joueurs : chaque
   * ligne cite une équipe source (`teamName`) et un joueur ; le joueur résolu
   * appartient à teamA ou teamB → vote majoritaire. Marche même quand AUCUN nom
   * d'équipe ne matche le nôtre (on s'appuie sur les rosters, pas sur les noms).
   */
  private sourceTeamSides(
    resolved: Array<{ line: ProviderResult['lines'][number]; local: NamedPlayer | null }>,
    context: MatchContext,
  ): Map<string, 'A' | 'B'> {
    const sideOfTeam = (teamId: string | null | undefined): 'A' | 'B' | null =>
      teamId && teamId === context.teamA?.id
        ? 'A'
        : teamId && teamId === context.teamB?.id
          ? 'B'
          : null;
    const votes = new Map<string, { A: number; B: number }>();
    for (const { line, local } of resolved) {
      const name = line.teamName?.trim();
      if (!name) continue;
      // Côté résolu par le provider (nom) prioritaire, sinon via le joueur (roster).
      const side = line.side ?? sideOfTeam((local as Player | null)?.teamId);
      if (!side) continue;
      const tally = votes.get(name) ?? { A: 0, B: 0 };
      tally[side] += 1;
      votes.set(name, tally);
    }
    const sides = new Map<string, 'A' | 'B'>();
    for (const [name, tally] of votes) {
      if (tally.A !== tally.B) sides.set(name, tally.A > tally.B ? 'A' : 'B');
    }
    return sides;
  }

  /**
   * Apprend les alias d'équipe depuis le mapping déduit des joueurs : si la
   * source nomme une équipe autrement que nous, on l'ajoute en alias — les
   * prochains matchs de cette équipe s'auto-résolvent par nom. Générique (tous
   * providers), fonctionne même si les DEUX noms diffèrent. Garde-fou : jamais
   * un nom déjà porté par une AUTRE équipe connue.
   */
  private async learnSourceAliases(
    match: Match,
    context: MatchContext,
    source: string,
    sideByTeam: Map<string, 'A' | 'B'>,
  ): Promise<void> {
    for (const [name, side] of sideByTeam) {
      const team = side === 'A' ? context.teamA : context.teamB;
      if (!team || teamMatches(name, team)) continue;
      // Nom trop court : jamais un alias crédible.
      if (normalizeName(name).length < 3) continue;
      if (await this.isOtherKnownTeam(name, match.gameId, team.id)) continue;
      await this.prisma.team.update({
        where: { id: team.id },
        data: { aliases: { push: name } },
      });
      team.aliases = [...(team.aliases ?? []), name];
      this.logger.log(`Alias appris via ${source} : « ${name} » → ${team.name}`);
    }
  }

  /** Vrai si un nom est déjà porté (nom ou alias) par une autre équipe du jeu. */
  private async isOtherKnownTeam(
    name: string,
    gameId: string,
    excludeTeamId: string,
  ): Promise<boolean> {
    const normalized = normalizeName(name);
    if (!normalized) return false;
    const teams = await this.prisma.team.findMany({
      where: { gameId, id: { not: excludeTeamId } },
      select: { name: true, aliases: true },
    });
    // Même sémantique que le matching (nom en flou, alias en exact) : un nom
    // qui « ressemble » à une autre équipe ne doit jamais devenir un alias.
    return teams.some((team) => teamMatches(name, team));
  }

  /** Fusionne le détail des manches du provider (map, scores) avec celui de Pandascore (winner, durée). */
  private async mergeProviderGames(
    match: Match,
    providerGames: ProviderGameInfo[],
    sideByTeam: Map<string, 'A' | 'B'>,
  ): Promise<void> {
    // Scores par côté : soit fournis directement (bo3), soit rattachés depuis
    // les scores bruts par nom d'équipe via le mapping joueurs (VLR).
    const resolved = providerGames.map((game) => {
      const base = { position: game.position, map: game.map, lengthSec: game.lengthSec };
      if (game.teams?.length) {
        const scoreOf = (side: 'A' | 'B') =>
          game.teams!.find((team) => sideByTeam.get(team.name.trim()) === side)?.score ?? null;
        return { ...base, scoreA: scoreOf('A'), scoreB: scoreOf('B') };
      }
      return { ...base, scoreA: game.scoreA, scoreB: game.scoreB };
    });
    const merged = mergeGamesSummary(match.gamesSummary, resolved);
    await this.prisma.match.update({
      where: { id: match.id },
      data: { gamesSummary: merged as unknown as Prisma.InputJsonValue },
    });
  }

  /**
   * Suggestions de noms provider pour le matching manuel : les deux équipes
   * locales du match + les noms candidats vus par la source (côté A/B) quand
   * une seule équipe est reconnue. Null si le match ou son contexte manque.
   */
  async suggestTeamNames(matchId: string) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return null;
    const context = await this.loadContext(match);
    if (!context.teamA || !context.teamB) return null;
    const provider = this.providers.find((candidate) => candidate.gameId === match.gameId);
    const candidates = provider?.suggestTeamNames
      ? await provider.suggestTeamNames(match, context).catch(() => [])
      : [];
    const asRef = (team: MatchContext['teamA']) =>
      team ? { id: team.id, name: team.name, aliases: team.aliases } : null;
    return { teamA: asRef(context.teamA), teamB: asRef(context.teamB), candidates };
  }

  private async loadContext(match: Match): Promise<MatchContext> {
    const teamIds = [match.teamAId, match.teamBId].filter((id): id is string => Boolean(id));
    const [teams, players] = await Promise.all([
      this.prisma.team.findMany({ where: { id: { in: teamIds } } }),
      this.prisma.player.findMany({ where: { teamId: { in: teamIds } } }),
    ]);
    return {
      teamA: teams.find((team) => team.id === match.teamAId) ?? null,
      teamB: teams.find((team) => team.id === match.teamBId) ?? null,
      players,
    };
  }

  private async publish(match: Match, source: string): Promise<void> {
    const event: StatsIngestedEvent = {
      matchId: match.id,
      gameId: match.gameId as GameId,
      source,
      ingestedAt: new Date().toISOString(),
    };
    await this.statsIngestedQueue.add('stats-ingested', event, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    this.liveEvents.emitMatchUpdated({ matchId: match.id, gameId: match.gameId });
    this.logger.log(`stats.ingested publié pour ${match.name} (source: ${source})`);
  }
}
