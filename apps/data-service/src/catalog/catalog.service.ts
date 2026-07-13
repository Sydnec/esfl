import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { normalizeName } from '../stats/matching';
import { PrismaService } from '../prisma.service';

/**
 * Normalise une saisie admin (URL VLR.gg, chemin, ou id de match) en chemin
 * relatif — la forme attendue par le provider (`${BASE_URL}${path}`). Null si
 * la saisie ne ressemble pas à une page de match VLR (segment numérique en tête).
 */
function normalizeVlrPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let path = trimmed;
  if (/vlr\.gg/i.test(trimmed)) {
    try {
      path = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return /^\/\d+/.test(path) ? path : null;
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ids distincts des matchs ayant au moins une ligne de stats. */
  async distinctStatsMatchIds(): Promise<string[]> {
    const rows = await this.prisma.playerMatchStats.findMany({
      distinct: ['matchId'],
      select: { matchId: true },
    });
    return rows.map((row) => row.matchId);
  }

  listCompetitions(gameId?: string, search?: string) {
    return this.prisma.competition.findMany({
      where: {
        ...(gameId ? { gameId } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ beginAt: 'desc' }],
      take: 100,
    });
  }

  async getCompetition(id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      include: { teams: { include: { team: true } } },
    });
    if (!competition) {
      throw new NotFoundException('Compétition introuvable');
    }
    return competition;
  }

  async listMatches(competitionIds: string[], from?: Date, to?: Date) {
    const matches = await this.prisma.match.findMany({
      where: {
        ...(competitionIds.length ? { competitionId: { in: competitionIds } } : {}),
        ...(from || to
          ? { scheduledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
        // CS2 : les matchs que Grid ne référence pas n'auront jamais de
        // stats — on ne les expose nulle part (accueil, board, scoring).
        // OR explicite : un NOT exclurait aussi les null (pas encore vérifiés).
        OR: [{ gameId: { not: 'cs2' } }, { gridCovered: true }, { gridCovered: null }],
      },
      orderBy: { scheduledAt: 'asc' },
      take: 500,
      include: { competition: { select: { id: true, name: true, gameId: true } } },
    });

    // teamA/teamB sont des ids sans relation Prisma : on résout en une requête.
    const teamIds = [
      ...new Set(matches.flatMap((m) => [m.teamAId, m.teamBId]).filter((id): id is string => !!id)),
    ];
    const teams = await this.prisma.team.findMany({ where: { id: { in: teamIds } } });
    const byId = new Map(teams.map((team) => [team.id, team]));
    return matches.map((match) => ({
      ...match,
      teamA: match.teamAId ? (byId.get(match.teamAId) ?? null) : null,
      teamB: match.teamBId ? (byId.get(match.teamBId) ?? null) : null,
    }));
  }

  /** Joueurs alignables : ceux des équipes engagées dans les compétitions données. */
  async listPlayers(competitionIds: string[]) {
    if (competitionIds.length === 0) return [];
    const entries = await this.prisma.competitionTeam.findMany({
      where: { competitionId: { in: competitionIds } },
      select: { teamId: true },
    });
    const teamIds = [...new Set(entries.map((entry) => entry.teamId))];
    return this.prisma.player.findMany({
      where: { teamId: { in: teamIds } },
      include: { team: { select: { id: true, name: true, acronym: true, imageUrl: true } } },
      orderBy: [{ gameId: 'asc' }, { name: 'asc' }],
    });
  }

  /** Fiche d'un joueur pro avec son équipe complète (page détail joueur). */
  async getPlayer(id: string) {
    const player = await this.prisma.player.findUnique({
      where: { id },
      include: { team: true },
    });
    if (!player) {
      throw new NotFoundException('Joueur introuvable');
    }
    return player;
  }

  /** Historique d'un joueur : ses stats jointes aux matchs (équipes résolues). */
  async listPlayerMatches(playerId: string) {
    const lines = await this.prisma.playerMatchStats.findMany({
      where: { playerId },
      include: {
        match: { include: { competition: { select: { id: true, name: true, gameId: true } } } },
      },
      orderBy: { match: { scheduledAt: 'desc' } },
      take: 100,
    });

    // teamA/teamB sont des ids sans relation Prisma : on résout en une requête.
    const teamIds = [
      ...new Set(
        lines
          .flatMap((line) => [line.match.teamAId, line.match.teamBId])
          .filter((id): id is string => !!id),
      ),
    ];
    const teams = await this.prisma.team.findMany({ where: { id: { in: teamIds } } });
    const byId = new Map(teams.map((team) => [team.id, team]));
    return lines.map(({ raw: _raw, match, ...line }) => ({
      ...line,
      match: {
        ...match,
        teamA: match.teamAId ? (byId.get(match.teamAId) ?? null) : null,
        teamB: match.teamBId ? (byId.get(match.teamBId) ?? null) : null,
      },
    }));
  }

  /** Résolution de joueurs par ids (noms, équipes, images) — pour les tops de journée. */
  listPlayersByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.player.findMany({
      where: { id: { in: ids.slice(0, 100) } },
      include: { team: { select: { id: true, name: true, acronym: true, imageUrl: true } } },
    });
  }

  listStats(matchIds: string[]) {
    if (matchIds.length === 0) return [];
    return this.prisma.playerMatchStats.findMany({ where: { matchId: { in: matchIds } } });
  }

  /** Détail d'un match avec équipes résolues (page match). */
  async getMatch(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { competition: true },
    });
    if (!match) return null;
    const teamIds = [match.teamAId, match.teamBId].filter((value): value is string => !!value);
    const teams = await this.prisma.team.findMany({ where: { id: { in: teamIds } } });
    return {
      ...match,
      teamA: teams.find((team) => team.id === match.teamAId) ?? null,
      teamB: teams.find((team) => team.id === match.teamBId) ?? null,
    };
  }

  /**
   * Équipes impliquées dans un match fini récent (7j) sans stats : candidates
   * probables à un alias manquant. Dédupliquées, avec un match d'exemple.
   */
  async unmatchedTeams() {
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        endAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
        teamAId: { not: null },
        teamBId: { not: null },
        stats: { none: {} },
      },
      select: { id: true, name: true, gameId: true, endAt: true, teamAId: true, teamBId: true },
      orderBy: { endAt: 'desc' },
      take: 300,
    });
    const teamIds = [
      ...new Set(matches.flatMap((match) => [match.teamAId, match.teamBId])),
    ].filter((id): id is string => Boolean(id));
    const teams = new Map(
      (
        await this.prisma.team.findMany({
          where: { id: { in: teamIds } },
          select: { id: true, name: true, gameId: true, aliases: true },
        })
      ).map((team) => [team.id, team]),
    );

    // Une entrée par équipe, avec le match le plus récent comme exemple.
    const byTeam = new Map<
      string,
      { id: string; name: string; gameId: string; aliases: string[]; matchId: string; matchName: string; endAt: string | null }
    >();
    for (const match of matches) {
      for (const teamId of [match.teamAId, match.teamBId]) {
        if (!teamId || byTeam.has(teamId)) continue;
        const team = teams.get(teamId);
        if (!team) continue;
        byTeam.set(teamId, {
          id: team.id,
          name: team.name,
          gameId: team.gameId,
          aliases: team.aliases,
          matchId: match.id,
          matchName: match.name,
          endAt: match.endAt?.toISOString() ?? null,
        });
      }
    }
    return [...byTeam.values()];
  }

  /**
   * Fixe manuellement la page VLR d'un match Valorant (statsPageUrl) : le
   * provider la parsera directement au lieu de chercher par nom d'équipe.
   * Accepte une URL complète, un chemin, ou l'id de match VLR.
   */
  async setValorantStatsPage(matchId: string, rawUrl: string): Promise<{ statsPageUrl: string }> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) throw new NotFoundException(`Match inconnu : ${matchId}`);
    if (match.gameId !== 'valorant') {
      throw new BadRequestException('La page manuelle n’est disponible que pour Valorant (VLR).');
    }
    const path = normalizeVlrPath(rawUrl);
    if (!path) {
      throw new BadRequestException('URL VLR.gg invalide (attendu : lien, chemin, ou id de match).');
    }
    await this.prisma.match.update({ where: { id: matchId }, data: { statsPageUrl: path } });
    return { statsPageUrl: path };
  }

  /** Recherche de matchs par nom (admin : poser une page VLR / relancer sur n'importe quel match). */
  async searchMatches(query: string) {
    const q = query.trim();
    if (q.length < 2) return [];
    const matches = await this.prisma.match.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      select: { id: true, name: true, gameId: true, status: true, endAt: true, statsPageUrl: true },
      orderBy: { scheduledAt: 'desc' },
      take: 25,
    });
    const withStats = new Set(
      (
        await this.prisma.playerMatchStats.findMany({
          where: { matchId: { in: matches.map((match) => match.id) } },
          distinct: ['matchId'],
          select: { matchId: true },
        })
      ).map((row) => row.matchId),
    );
    return matches.map((match) => ({
      ...match,
      endAt: match.endAt?.toISOString() ?? null,
      hasStats: withStats.has(match.id),
    }));
  }

  /** Recherche d'équipes par nom ou alias (matching manuel admin). */
  async searchTeams(query: string, gameId?: string) {
    const q = query.trim();
    if (q.length < 2) return [];
    return this.prisma.team.findMany({
      where: {
        ...(gameId ? { gameId } : {}),
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { aliases: { has: q } }],
      },
      select: { id: true, gameId: true, name: true, acronym: true, aliases: true },
      orderBy: { name: 'asc' },
      take: 25,
    });
  }

  /**
   * Ajoute un alias provider à une équipe (matching manuel) et renvoie les
   * matchs récents de l'équipe à ré-ingérer pour que le rapprochement prenne
   * effet sans attendre. Alias dédupliqué par forme normalisée.
   */
  async addTeamAlias(teamId: string, alias: string): Promise<{ aliases: string[]; matchIds: string[] }> {
    const clean = alias.trim();
    if (!clean || !normalizeName(clean)) {
      throw new BadRequestException('Alias vide ou sans caractère alphanumérique');
    }
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException(`Équipe inconnue : ${teamId}`);
    const exists = team.aliases.some((a) => normalizeName(a) === normalizeName(clean));
    const aliases = exists ? team.aliases : [...team.aliases, clean];
    if (!exists) {
      await this.prisma.team.update({ where: { id: teamId }, data: { aliases } });
    }
    return { aliases, matchIds: await this.recentMatchIdsForTeam(teamId) };
  }

  /** Retire un alias d'une équipe. */
  async removeTeamAlias(teamId: string, alias: string): Promise<{ aliases: string[] }> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException(`Équipe inconnue : ${teamId}`);
    const target = normalizeName(alias);
    const aliases = team.aliases.filter((a) => normalizeName(a) !== target);
    await this.prisma.team.update({ where: { id: teamId }, data: { aliases } });
    return { aliases };
  }

  /** Matchs finis < 7j sans stats impliquant l'équipe (à ré-ingérer après ajout d'alias). */
  private async recentMatchIdsForTeam(teamId: string): Promise<string[]> {
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        endAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
        OR: [{ teamAId: teamId }, { teamBId: teamId }],
      },
      select: { id: true },
    });
    return matches.map((match) => match.id);
  }

  /**
   * Santé de l'ingestion pour la page admin, tous jeux confondus : activité
   * (en cours, à venir 24h, finis 48h et leur couverture stats), matchs en
   * cours avec fraîcheur des stats live, catalogue (compétitions suivies,
   * équipes, joueurs), état des sources de stats, couverture Grid CS2, queue
   * BullMQ (échecs détaillés), alias appris et quota Pandascore.
   */
  async ingestionHealth(
    queue: Queue,
    pandascoreRequestsLastHour: number,
    followedCompetitionIds: string[] | null,
  ) {
    const now = Date.now();
    const since48h = new Date(now - 48 * 3600 * 1000);
    // Fenêtre large (7 j) pour la couverture par jeu ; le détail des matchs
    // sans stats et l'activité restent sur 48 h.
    const finished7j = await this.prisma.match.findMany({
      where: { status: 'finished', endAt: { gte: new Date(now - 7 * 24 * 3600 * 1000) } },
      select: { id: true, gameId: true, name: true, endAt: true, gridCovered: true },
      orderBy: { endAt: 'desc' },
    });
    // Les stats ne sont ingérées que pour les compétitions suivies : l'ensemble
    // des matchs avec stats est petit, un distinct non filtré évite un IN de
    // milliers d'ids.
    const withStats = new Set(
      (
        await this.prisma.playerMatchStats.findMany({
          distinct: ['matchId'],
          select: { matchId: true },
        })
      ).map((row) => row.matchId),
    );
    const finished = finished7j.filter((match) => match.endAt && match.endAt >= since48h);

    const couverture7j: Record<string, { finis: number; avecStats: number }> = {};
    for (const match of finished7j) {
      couverture7j[match.gameId] ??= { finis: 0, avecStats: 0 };
      couverture7j[match.gameId].finis += 1;
      if (withStats.has(match.id)) couverture7j[match.gameId].avecStats += 1;
    }

    const running = await this.prisma.match.findMany({
      where: { status: 'running' },
      select: { id: true, gameId: true, name: true, beginAt: true },
      orderBy: { beginAt: 'asc' },
    });
    const runningStatsMaj = new Map(
      (
        await this.prisma.playerMatchStats.groupBy({
          by: ['matchId'],
          where: { matchId: { in: running.map((match) => match.id) } },
          _max: { updatedAt: true },
        })
      ).map((row) => [row.matchId, row._max.updatedAt]),
    );
    const upcomingByGame = new Map(
      (
        await this.prisma.match.groupBy({
          by: ['gameId'],
          where: {
            status: 'not_started',
            scheduledAt: { gte: new Date(now), lte: new Date(now + 24 * 3600 * 1000) },
          },
          _count: { _all: true },
        })
      ).map((row) => [row.gameId, row._count._all]),
    );

    const parJeu: Record<
      string,
      { enCours: number; aVenir24h: number; finis: number; avecStats: number }
    > = {};
    const jeu = (gameId: string) =>
      (parJeu[gameId] ??= {
        enCours: 0,
        aVenir24h: upcomingByGame.get(gameId) ?? 0,
        finis: 0,
        avecStats: 0,
      });
    for (const match of finished) {
      const entry = jeu(match.gameId);
      entry.finis += 1;
      if (withStats.has(match.id)) entry.avecStats += 1;
    }
    for (const match of running) jeu(match.gameId).enCours += 1;
    for (const gameId of upcomingByGame.keys()) jeu(gameId);

    // Borné : au-delà, la liste est un symptôme global (source en panne),
    // pas une liste d'actions unitaires — le compteur par jeu suffit.
    const SANS_STATS_MAX = 100;
    const sansStats = finished
      .filter((match) => !withStats.has(match.id))
      // Les CS2 hors couverture Grid n'auront jamais de stats : signalés à part.
      .slice(0, SANS_STATS_MAX)
      .map((match) => ({ ...match, endAt: match.endAt?.toISOString() ?? null }));

    const enCours = running.map((match) => ({
      id: match.id,
      gameId: match.gameId,
      name: match.name,
      beginAt: match.beginAt?.toISOString() ?? null,
      statsMaj: runningStatsMaj.get(match.id)?.toISOString() ?? null,
    }));

    // Catalogue par jeu : volumes + compétitions suivies par au moins une ligue.
    const countByGame = (rows: Array<{ gameId: string; _count: { _all: number } }>) =>
      new Map(rows.map((row) => [row.gameId, row._count._all]));
    const [competitionsByGame, teamsByGame, playersByGame] = await Promise.all([
      this.prisma.competition
        .groupBy({ by: ['gameId'], _count: { _all: true } })
        .then(countByGame),
      this.prisma.team.groupBy({ by: ['gameId'], _count: { _all: true } }).then(countByGame),
      this.prisma.player.groupBy({ by: ['gameId'], _count: { _all: true } }).then(countByGame),
    ]);
    const followed = followedCompetitionIds
      ? await this.prisma.competition.findMany({
          where: { id: { in: followedCompetitionIds } },
          select: { gameId: true },
        })
      : null;
    const followedByGame = new Map<string, number>();
    for (const competition of followed ?? []) {
      followedByGame.set(competition.gameId, (followedByGame.get(competition.gameId) ?? 0) + 1);
    }
    const gameIds = new Set([
      ...competitionsByGame.keys(),
      ...teamsByGame.keys(),
      ...playersByGame.keys(),
    ]);
    const catalogue = Object.fromEntries(
      [...gameIds].map((gameId) => [
        gameId,
        {
          competitions: competitionsByGame.get(gameId) ?? 0,
          suivies: followed ? (followedByGame.get(gameId) ?? 0) : null,
          equipes: teamsByGame.get(gameId) ?? 0,
          joueurs: playersByGame.get(gameId) ?? 0,
        },
      ]),
    );

    // État des sources de stats détaillées (clé configurée côté service).
    const sources = [
      { gameId: 'cs2', source: 'Grid', configuree: Boolean(process.env.GRID_API_KEY), live: true },
      { gameId: 'valorant', source: 'VLR.gg', configuree: true, live: true },
      { gameId: 'lol', source: 'Leaguepedia', configuree: true, live: false },
      {
        gameId: 'rl',
        source: 'ballchasing.com',
        configuree: Boolean(process.env.BALLCHASING_API_KEY),
        live: false,
      },
    ];

    const [gridTrue, gridFalse, gridNull] = await Promise.all([
      this.prisma.match.count({ where: { gameId: 'cs2', gridCovered: true } }),
      this.prisma.match.count({ where: { gameId: 'cs2', gridCovered: false } }),
      this.prisma.match.count({ where: { gameId: 'cs2', gridCovered: null } }),
    ]);

    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const failedJobs = await queue.getFailed(0, 19);
    const echecs = failedJobs.map((job) => ({
      name: job.name,
      data: job.data as Record<string, unknown>,
      raison: job.failedReason ?? null,
      tentatives: job.attemptsMade,
    }));

    const aliases = await this.prisma.team.findMany({
      where: { NOT: { aliases: { isEmpty: true } } },
      select: { gameId: true, name: true, aliases: true },
      orderBy: { name: 'asc' },
    });

    return {
      generatedAt: new Date().toISOString(),
      parJeu,
      couverture7j,
      enCours,
      catalogue,
      sources,
      sansStats,
      couvertureGrid: { couverts: gridTrue, horsCouverture: gridFalse, aVerifier: gridNull },
      queue: { ...counts, echecs },
      aliases,
      pandascore: { requetesDerniereHeure: pandascoreRequestsLastHour, quotaHoraire: 1000 },
    };
  }
}
