import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { normalizeName, teamNamesMatch } from '../stats/matching';
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

/**
 * Extrait le nom d'équipe d'un lien Leaguepedia (lol.fandom.com/wiki/Nom_Equipe)
 * pour l'utiliser comme alias : le titre de page correspond au nom que
 * Leaguepedia met dans ses scoreboards. Une saisie qui n'est pas une telle URL
 * est renvoyée telle quelle (l'admin a tapé le nom directement).
 */
function fandomTeamName(raw: string): string {
  const trimmed = raw.trim();
  if (!/lol\.fandom\.com\/wiki\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const slug = url.pathname.split('/wiki/')[1] ?? '';
    const name = decodeURIComponent(slug).replace(/_/g, ' ').trim();
    return name || trimmed;
  } catch {
    return trimmed;
  }
}

/** Noms lisibles des jobs BullMQ, pour la liste des échecs de la page admin. */
const JOB_LABELS: Record<string, string> = {
  'ingest-stats': 'Ingestion des stats',
  'sync-series': 'Sync du catalogue',
  'sync-matches': 'Sync des matchs',
  'sync-rosters': 'Sync des rosters',
  'sync-live': 'Fenêtre live (scores)',
  'sync-live-stats': 'Stats live',
  'sync-competition': 'Sync d’une compétition',
  'check-grid-coverage': 'Couverture Grid (CS2)',
};

/**
 * Raison d'échec présentable : garde le message d'erreur applicatif (déjà en
 * français côté providers) mais coupe la stack et les préfixes techniques
 * verbeux pour n'afficher que la première ligne utile.
 */
function humanizeFailure(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const firstLine = reason.split('\n')[0].trim();
  return firstLine.replace(/^Error:\s*/i, '') || null;
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
        // Irrécupérables masquées + tier c/d exclus (catalogue restreint S/A/B,
        // tier null accepté) : jamais proposées au parcours ni au suivi.
        hidden: false,
        OR: [{ tier: null }, { tier: { notIn: ['c', 'd'] } }],
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
    // Masquée (irrécupérable) ou tier c/d = introuvable côté public : bloque
    // aussi la validation de suivi côté fantasy (leagues.service l'appelle).
    if (!competition || competition.hidden || competition.tier === 'c' || competition.tier === 'd') {
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
        // Irrécupérable ou tier c/d : masquée partout (accueil, board, scoring).
        competition: { hidden: false, OR: [{ tier: null }, { tier: { notIn: ['c', 'd'] } }] },
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

  /** Ids des joueurs ayant réellement des stats dans une compétition (ceux qui ont joué). */
  async statPlayerIds(competitionId: string): Promise<string[]> {
    const rows = await this.prisma.playerMatchStats.findMany({
      where: { match: { competitionId } },
      select: { playerId: true },
      distinct: ['playerId'],
    });
    return rows.map((row) => row.playerId);
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
   * Ce qui reste à corriger à la main sur les matchs finis récents (7j) sans
   * stats. On ne surface que le vrai travail de matching, pas les trous de
   * couverture (cf. `statsFailureKind`, posé à l'ingestion) :
   * - jeux à alias (CS2/LoL/RL) : seulement les matchs `name-mismatch`, et pour
   *   chacun uniquement l'équipe non reconnue, avec les noms candidats vus par
   *   la source (`statsSuggestion`) pré-remplis ;
   * - Valorant : tous les matchs sans stats (la remédiation est le lien VLR,
   *   quelle que soit la cause) — dédupliqués par match côté front.
   */
  async unmatchedTeams() {
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        endAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
        teamAId: { not: null },
        teamBId: { not: null },
        stats: { none: {} },
        OR: [
          { gameId: 'valorant' },
          { gameId: { not: 'valorant' }, statsFailureKind: 'name-mismatch' },
        ],
      },
      select: {
        id: true,
        name: true,
        gameId: true,
        endAt: true,
        teamAId: true,
        teamBId: true,
        statsSuggestion: true,
      },
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

    interface Entry {
      id: string;
      name: string;
      gameId: string;
      aliases: string[];
      matchId: string;
      matchName: string;
      endAt: string | null;
      /** Noms provider candidats pour cette équipe (pré-remplissage). */
      candidates: string[];
    }
    const byTeam = new Map<string, Entry>();
    const add = (teamId: string | null, match: (typeof matches)[number], candidates: string[]) => {
      if (!teamId || byTeam.has(teamId)) return;
      const team = teams.get(teamId);
      if (!team) return;
      byTeam.set(teamId, {
        id: team.id,
        name: team.name,
        gameId: team.gameId,
        aliases: team.aliases,
        matchId: match.id,
        matchName: match.name,
        endAt: match.endAt?.toISOString() ?? null,
        candidates,
      });
    };

    for (const match of matches) {
      if (match.gameId === 'valorant') {
        // Piloté par le lien VLR : les deux équipes portent le match (dédup front).
        add(match.teamAId, match, []);
        add(match.teamBId, match, []);
        continue;
      }
      // name-mismatch : seule l'équipe du côté non reconnu est en cause.
      const suggestion = (match.statsSuggestion ?? []) as Array<{ side: 'A' | 'B'; name: string }>;
      const namesBySide = new Map<'A' | 'B', string[]>();
      for (const candidate of suggestion) {
        namesBySide.set(candidate.side, [...(namesBySide.get(candidate.side) ?? []), candidate.name]);
      }
      for (const [side, names] of namesBySide) {
        add(side === 'A' ? match.teamAId : match.teamBId, match, names);
      }
    }
    return [...byTeam.values()];
  }

  /**
   * Ids des matchs finis récents, dans une compétition suivie, sans stats mais
   * a priori récupérables : la source a la donnée, il manque juste le job
   * d'ingestion (matchs recréés par un re-sync, > 48h, donc jamais ré-ingérés
   * seuls). CS2 hors couverture Grid (gridCovered=false) est écarté — il
   * n'aura jamais de stats ; la couverture non vérifiée (null) est retentée.
   * `null` = fantasy-service injoignable : on ne tente rien plutôt que tout.
   */
  async reingestableMatchIds(
    followedCompetitionIds: string[] | null,
    days: number,
  ): Promise<string[]> {
    if (followedCompetitionIds === null) return [];
    if (followedCompetitionIds.length === 0) return [];
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        endAt: { gte: since },
        teamAId: { not: null },
        teamBId: { not: null },
        stats: { none: {} },
        competitionId: { in: followedCompetitionIds },
        NOT: { gameId: 'cs2', gridCovered: false },
      },
      select: { id: true },
      orderBy: { endAt: 'desc' },
      take: 1000,
    });
    return matches.map((match) => match.id);
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
  async addTeamAliases(
    teamId: string,
    rawNames: string[],
  ): Promise<{ aliases: string[]; matchIds: string[]; added: string[]; redundant: boolean }> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException(`Équipe inconnue : ${teamId}`);
    const aliases = [...team.aliases];
    const added: string[] = [];
    for (const raw of rawNames) {
      // Un lien lol.fandom.com résiduel est converti en nom ; sinon saisie brute.
      const clean = fandomTeamName(raw);
      if (!clean || !normalizeName(clean)) continue;
      // Redondant : le matcher flou reconnaît déjà ce nom comme l'équipe —
      // l'alias n'apporterait rien (évite « Volticons → Volticons », « LY »…).
      if (teamNamesMatch(clean, team.name)) continue;
      const normalized = normalizeName(clean);
      if (aliases.some((existing) => normalizeName(existing) === normalized)) continue;
      aliases.push(clean);
      added.push(clean);
    }
    if (added.length > 0) {
      await this.prisma.team.update({ where: { id: teamId }, data: { aliases } });
    }
    return {
      aliases,
      matchIds: added.length > 0 ? await this.recentMatchIdsForTeam(teamId) : [],
      added,
      redundant: added.length === 0,
    };
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
    const failedJobs = await queue.getFailed(0, 49);
    // Cible lisible : les jobs ingest-stats portent un matchId, résolu en nom.
    const failedMatchIds = [
      ...new Set(
        failedJobs
          .map((job) => (job.data as { matchId?: string }).matchId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const failedMatches = new Map(
      (
        await this.prisma.match.findMany({
          where: { id: { in: failedMatchIds } },
          select: { id: true, name: true, gameId: true },
        })
      ).map((match) => [match.id, match]),
    );
    const echecs = failedJobs.map((job) => {
      const data = job.data as { matchId?: string };
      const match = data.matchId ? failedMatches.get(data.matchId) : undefined;
      // matchId présent mais match absent de la base : reliquat visant un match
      // supprimé (purge + re-sync l'ont recréé sous un autre id) — plus rien à
      // relancer, on ne conserve un matchId que s'il est résolvable.
      const introuvable = Boolean(data.matchId) && !match;
      return {
        id: job.id ?? null,
        job: job.name,
        jobLabel: JOB_LABELS[job.name] ?? job.name,
        matchId: match?.id ?? null,
        gameId: match?.gameId ?? null,
        cible: match?.name ?? null,
        introuvable,
        raison: humanizeFailure(job.failedReason),
        tentatives: job.attemptsMade,
      };
    });

    // Les alias redondants (déjà reconnus via le nom) sont du bruit : on ne les
    // affiche pas — seuls comptent les vrais rebindings de nom.
    const aliases = (
      await this.prisma.team.findMany({
        where: { NOT: { aliases: { isEmpty: true } } },
        select: { gameId: true, name: true, aliases: true },
        orderBy: { name: 'asc' },
      })
    )
      .map((team) => ({
        ...team,
        aliases: team.aliases.filter((alias) => !teamNamesMatch(alias, team.name)),
      }))
      .filter((team) => team.aliases.length > 0);

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

  /**
   * Purge les jobs en échec qui visent un match absent de la base : reliquats
   * d'un match supprimé puis recréé sous un autre id (purge + re-sync). Ils ne
   * pointent sur rien de relançable et polluent la liste des échecs.
   */
  async pruneObsoleteFailures(queue: Queue): Promise<{ removed: number }> {
    const failed = await queue.getFailed(0, 499);
    const targets = failed
      .map((job) => ({ job, matchId: (job.data as { matchId?: string }).matchId }))
      .filter((entry): entry is { job: (typeof failed)[number]; matchId: string } =>
        Boolean(entry.matchId),
      );
    const ids = [...new Set(targets.map((target) => target.matchId))];
    const existing = new Set(
      (
        await this.prisma.match.findMany({ where: { id: { in: ids } }, select: { id: true } })
      ).map((match) => match.id),
    );
    let removed = 0;
    for (const { job, matchId } of targets) {
      if (!existing.has(matchId)) {
        await job.remove();
        removed += 1;
      }
    }
    return { removed };
  }

  /**
   * Instantané détaillé de la file BullMQ pour la page admin : compteurs par
   * état + liste des jobs (attente, actif, retry programmé, échec) avec cible
   * lisible. Les jobs `ingest-stats` portent un matchId résolu en nom de match.
   */
  async queueSnapshot(queue: Queue) {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
    );
    const [waiting, active, delayed, failed] = await Promise.all([
      queue.getWaiting(0, 49),
      queue.getActive(0, 49),
      queue.getDelayed(0, 49),
      queue.getFailed(0, 49),
    ]);
    const groups: Array<{ state: 'waiting' | 'active' | 'delayed' | 'failed'; jobs: Job[] }> = [
      { state: 'active', jobs: active },
      { state: 'delayed', jobs: delayed },
      { state: 'waiting', jobs: waiting },
      { state: 'failed', jobs: failed },
    ];

    // Résolution groupée matchId → nom (les jobs ingest-stats visent un match).
    const matchIds = [
      ...new Set(
        groups
          .flatMap((group) => group.jobs)
          .map((job) => (job.data as { matchId?: string }).matchId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const matches = new Map(
      (
        await this.prisma.match.findMany({
          where: { id: { in: matchIds } },
          select: { id: true, name: true, gameId: true },
        })
      ).map((match) => [match.id, match]),
    );

    const jobs = groups.flatMap((group) =>
      group.jobs.map((job) => {
        const data = job.data as { matchId?: string };
        const match = data.matchId ? matches.get(data.matchId) : undefined;
        return {
          id: job.id ?? null,
          job: job.name,
          jobLabel: JOB_LABELS[job.name] ?? job.name,
          state: group.state,
          matchId: match?.id ?? null,
          gameId: match?.gameId ?? null,
          // matchId présent mais match absent : reliquat visant un match supprimé.
          cible: match?.name ?? (data.matchId ? null : (JOB_LABELS[job.name] ?? job.name)),
          introuvable: Boolean(data.matchId) && !match,
          // Job produit par un scheduler répétable (sync planifié) : ne pas vider.
          recurrent: Boolean(job.repeatJobKey),
          raison: group.state === 'failed' ? humanizeFailure(job.failedReason) : null,
          tentatives: job.attemptsMade,
        };
      }),
    );

    return { counts, jobs };
  }

  /**
   * Vide la file selon l'état demandé, en préservant toujours les jobs des
   * schedulers répétables (sync planifiés) et les jobs actifs (en cours) :
   * - `completed` / `failed` : purge les jobs terminés ou en échec.
   * - `pending` : retire les jobs en attente et les retries programmés
   *   (`waiting` + `delayed`) sauf ceux produits par un scheduler.
   * - `all` : combine les trois.
   */
  async cleanQueue(
    queue: Queue,
    state: 'completed' | 'failed' | 'pending' | 'all',
  ): Promise<{ removed: number }> {
    let removed = 0;
    if (state === 'completed' || state === 'all') {
      removed += (await queue.clean(0, 0, 'completed')).length;
    }
    if (state === 'failed' || state === 'all') {
      removed += (await queue.clean(0, 0, 'failed')).length;
    }
    if (state === 'pending' || state === 'all') {
      // On ne passe pas par queue.clean('delayed') : il supprimerait aussi les
      // occurrences planifiées des syncs répétables. On filtre sur repeatJobKey.
      const pending = [...(await queue.getWaiting()), ...(await queue.getDelayed())];
      for (const job of pending) {
        if (job.repeatJobKey) continue;
        await job.remove();
        removed += 1;
      }
    }
    return { removed };
  }
}
