import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parisDate } from '@esfl/contracts';
import type { Job, Queue } from 'bullmq';
import { Prisma } from '../../generated/client';
import { FENETRE_ARBITRAGE_MS } from '../ingestion/ingestion.constants';
import { evaluerCoherence } from '../stats/coherence';
import { reassignPlayerStats } from '../common/player-merge';
import { normalizeName, pseudosProches, teamNamesMatch } from '../stats/matching';
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
/** Nombre de manches jouées (manches décidées, sinon somme des scores, sinon 1). */
function statMaps(match: {
  scoreA: number | null;
  scoreB: number | null;
  gamesSummary: unknown;
}): number {
  const games = Array.isArray(match.gamesSummary)
    ? (match.gamesSummary as Array<{ winner?: unknown }>)
    : [];
  const decided = games.filter((game) => game.winner != null).length;
  if (decided > 0) return decided;
  const fromScore = (match.scoreA ?? 0) + (match.scoreB ?? 0);
  return fromScore > 0 ? fromScore : 1;
}

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

/**
 * Identité civile normalisée d'une fiche, ou null si elle est incomplète.
 * Les deux parties sont exigées : un prénom seul est bien trop partagé pour
 * servir de clé d'identité.
 */
export function identiteCivile(firstName: string | null, lastName: string | null): string | null {
  if (!firstName?.trim() || !lastName?.trim()) return null;
  // Chaque partie normalisée SÉPARÉMENT : `normalizeName` supprime tout ce qui
  // n'est pas alphanumérique, espace compris, si bien qu'une concaténation
  // brute confondait « Kimm Inseong » et « Kim Minseong ». Le séparateur est
  // posé après normalisation pour survivre.
  const prenom = normalizeName(firstName);
  const nom = normalizeName(lastName);
  if (!prenom || !nom) return null;
  return `${prenom}|${nom}`;
}

/**
 * Découpe les fiches d'une même identité civile en groupes de pseudos
 * proches. Deux personnes peuvent porter le même nom civil sans être la même
 * (« Kim Min-seong » en LoL) : seul le pseudo tranche. Regroupement transitif,
 * un pseudo intermédiaire reliant les deux extrêmes.
 */
export function clustersParPseudo<T extends { name: string }>(fiches: T[]): T[][] {
  const clusters: T[][] = [];
  for (const fiche of fiches) {
    // TOUS les groupes que cette fiche touche, pas seulement le premier :
    // si A et C ne se ressemblent pas mais que B ressemble aux deux, l'ordre
    // d'arrivée décidait du résultat (A, C, B laissait C isolé). En fusionnant,
    // le regroupement est réellement transitif et indépendant de l'ordre.
    const touches = clusters.filter((cluster) =>
      cluster.some((membre) => pseudosProches(membre.name, fiche.name)),
    );
    if (touches.length === 0) {
      clusters.push([fiche]);
      continue;
    }
    const [garde, ...absorbes] = touches;
    garde.push(fiche, ...absorbes.flat());
    for (const absorbe of absorbes) clusters.splice(clusters.indexOf(absorbe), 1);
  }
  return clusters;
}

/**
 * Filtre du catalogue public : tiers S/A/B, tier null accepté, c/d exclus.
 * Jumeau de `TIER_ALLOWED` côté ingestion, qui filtre la synchro.
 */
const TIER_PUBLIC: Prisma.CompetitionWhereInput = {
  OR: [{ tier: null }, { tier: { notIn: ['c', 'd'] } }],
};

/** Noms lisibles des jobs BullMQ, pour la liste des échecs de la page admin. */
const JOB_LABELS: Record<string, string> = {
  'ingest-stats': 'Ingestion des stats',
  'sync-series': 'Sync du catalogue',
  'sync-matches': 'Sync des matchs',
  'sync-rosters': 'Sync des rosters',
  'sync-live': 'Fenêtre live (scores)',
  'sync-live-stats': 'Stats live',
  'sync-competition': 'Sync d’une compétition',
  'adopt-orphan-players': 'Adoption des joueurs orphelins',
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

  /**
   * Catalogue des compétitions proposables.
   *
   * `from`/`to` restreignent aux compétitions qui ont au moins un match dans la
   * fenêtre : sans quoi les listes de choix accumulent tout l'historique et
   * deviennent inutilisables. `ids` force l'inclusion de compétitions hors
   * fenêtre (celles déjà suivies par une ligne, dont il faut encore le nom).
   */
  async listCompetitions(gameId?: string, search?: string, from?: Date, to?: Date, ids?: string[]) {
    // Irrécupérables masquées + tier c/d exclus (catalogue restreint S/A/B,
    // tier null accepté) : jamais proposées au parcours ni au suivi.
    const base = {
      hidden: false,
      ...TIER_PUBLIC,
      ...(gameId ? { gameId } : {}),
      ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
    };
    const fenetre =
      from || to
        ? {
            matches: {
              some: { scheduledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
            },
          }
        : {};
    const catalogue = await this.prisma.competition.findMany({
      where: { ...base, ...fenetre },
      orderBy: [{ beginAt: 'desc' }],
      take: 100,
    });
    if (!ids || ids.length === 0) return catalogue;

    // Requête séparée pour les compétitions forcées : rassemblées en un seul
    // `OR`, le plafond de 100 pouvait les écarter alors qu'elles sont là
    // précisément pour être résolues (le nom d'une compétition déjà suivie).
    const connus = new Set(catalogue.map((competition) => competition.id));
    const forcees = await this.prisma.competition.findMany({
      where: { ...base, id: { in: ids.filter((id) => !connus.has(id)) } },
    });
    return [...catalogue, ...forcees];
  }

  async getCompetition(id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      include: { teams: { include: { team: true } } },
    });
    // Masquée (irrécupérable) ou tier c/d = introuvable côté public : bloque
    // aussi la validation de suivi côté fantasy (leagues.service l'appelle).
    if (
      !competition ||
      competition.hidden ||
      competition.tier === 'c' ||
      competition.tier === 'd'
    ) {
      throw new NotFoundException('Compétition introuvable');
    }
    return competition;
  }

  /**
   * Fiche d'une équipe : identité, effectif actuel et compétitions engagées.
   *
   * L'effectif ne retient que les titulaires (`active`), comme `listPlayers` :
   * les joueurs partis restent atteignables par leur fiche, mais ne figurent
   * plus au roster affiché. Les compétitions masquées ou de tier c/d sont
   * exclues, cohérent avec le reste du catalogue public.
   */
  async getTeamDetail(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      // Sélection explicite : aliases, providerIds et fieldSources sont de la
      // plomberie d'ingestion, elle n'a rien à faire dans une fiche publique.
      select: {
        id: true,
        gameId: true,
        name: true,
        acronym: true,
        imageUrl: true,
        location: true,
        players: {
          where: { active: true },
          orderBy: [{ name: 'asc' }],
          // Mêmes champs publics que `PlayerRef` côté web : la plomberie
          // d'adoption (fieldSources, providerIds, adoptionTriedAt…) n'a pas
          // plus sa place ici que sur l'équipe.
          select: {
            id: true,
            gameId: true,
            name: true,
            role: true,
            imageUrl: true,
            nationality: true,
          },
        },
        competitions: {
          where: { competition: { hidden: false, ...TIER_PUBLIC } },
          select: {
            competition: {
              select: {
                id: true,
                name: true,
                gameId: true,
                tier: true,
                beginAt: true,
                endAt: true,
                imageUrl: true,
              },
            },
          },
        },
      },
    });
    if (!team) {
      throw new NotFoundException('Équipe introuvable');
    }
    const { competitions, ...reste } = team;
    return {
      ...reste,
      competitions: competitions
        .map((entry) => entry.competition)
        .sort((a, b) => (b.beginAt?.getTime() ?? 0) - (a.beginAt?.getTime() ?? 0)),
    };
  }

  async listMatches(competitionIds: string[], from?: Date, to?: Date, teamId?: string) {
    const matches = await this.prisma.match.findMany({
      where: {
        ...(competitionIds.length ? { competitionId: { in: competitionIds } } : {}),
        // teamA/teamB sont deux colonnes sans relation : l'équipe peut être
        // d'un côté comme de l'autre.
        ...(teamId ? { OR: [{ teamAId: teamId }, { teamBId: teamId }] } : {}),
        ...(from || to
          ? { scheduledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
        // Irrécupérable ou tier c/d : masquée partout (accueil, board, scoring).
        competition: { hidden: false, OR: [{ tier: null }, { tier: { notIn: ['c', 'd'] } }] },
      },
      // Tri décroissant pour que le plafond coupe les matchs les plus ANCIENS :
      // en croissant, une équipe ou une compétition dépassant `take` perdait
      // ses matchs récents, donc son actualité. L'ordre croissant attendu par
      // les appelants est rétabli juste après.
      orderBy: { scheduledAt: 'desc' },
      take: 500,
      include: { competition: { select: { id: true, name: true, gameId: true } } },
    });
    matches.reverse();

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
      // active : uniquement les titulaires actuels (réconciliés au sync des
      // rosters). Les joueurs partis restent résolubles ailleurs (getPlayer,
      // listPlayersByIds) pour l'historique, les fiches et les tops.
      where: { teamId: { in: teamIds }, active: true },
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

  /** Métadonnées légères de tous les joueurs (analytics de points, scoring interne). */
  playersMeta() {
    return this.prisma.player.findMany({
      select: {
        id: true,
        name: true,
        gameId: true,
        role: true,
        team: { select: { name: true, acronym: true } },
      },
    });
  }

  /** Résolution de joueurs par ids (noms, équipes, images) — pour les tops de journée. */
  listPlayersByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.player.findMany({
      where: { id: { in: ids.slice(0, 100) } },
      include: { team: { select: { id: true, name: true, acronym: true, imageUrl: true } } },
    });
  }

  async listStats(matchIds: string[]) {
    if (matchIds.length === 0) return [];
    const rows = await this.prisma.playerMatchStats.findMany({
      where: { matchId: { in: matchIds } },
      include: { player: { select: { role: true } } },
    });
    // Rôle du snapshot au match d'abord (vérité du moment T), repli sur le rôle
    // courant de la fiche pour les lignes historiques sans snapshot.
    return rows.map(({ player, ...rest }) => ({
      ...rest,
      role: rest.role ?? player?.role ?? null,
    }));
  }

  /**
   * Toutes les lignes de stats d'un jeu (matchs finis) pour le calcul des
   * distributions de scoring : joueur, rôle, normalized, nombre de manches.
   */
  async statsForScoring(gameId: string) {
    if (!gameId) return [];
    const rows = await this.prisma.playerMatchStats.findMany({
      where: { gameId, match: { status: 'finished' } },
      select: {
        playerId: true,
        matchId: true,
        normalized: true,
        role: true,
        player: { select: { role: true } },
        match: { select: { scoreA: true, scoreB: true, gamesSummary: true } },
      },
    });
    return rows.map((row) => ({
      playerId: row.playerId,
      matchId: row.matchId,
      // Rôle joué sur CE match (snapshot), repli sur le rôle courant.
      role: row.role ?? row.player?.role ?? null,
      normalized: row.normalized,
      maps: statMaps(row.match),
    }));
  }

  /**
   * Complétude des stats d'une journée Paris (base du gel des scores côté
   * scoring) : la journée est complète quand tous ses matchs sont terminés et
   * que tous les finis RÉCUPÉRABLES ont leurs stats.
   *
   * Un match diagnostiqué `no-coverage` n'est pas récupérable : la source ne le
   * référence pas, il n'aura jamais de stats. L'y compter empêcherait la
   * journée d'être complète et la ferait geler à l'échéance de trois jours,
   * avec un classement figé sur des données partielles. Un `name-mismatch`,
   * lui, reste comptabilisé : il se corrige par un alias depuis /admin, et
   * c'est justement cette pression qui doit rester visible.
   */
  async dayCompleteness(date: string, avecNonCouverts = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('Date attendue au format YYYY-MM-DD');
    }
    // Fenêtre large ±12h autour du jour UTC, puis filtre exact sur le jour
    // Paris (même convention que les journées fantasy).
    const base = Date.parse(`${date}T00:00:00Z`);
    const from = new Date(base - 12 * 3600 * 1000);
    const to = new Date(base + 36 * 3600 * 1000);
    const candidates = await this.prisma.match.findMany({
      where: {
        OR: [
          { beginAt: { gte: from, lte: to } },
          { beginAt: null, scheduledAt: { gte: from, lte: to } },
        ],
        competition: { hidden: false, OR: [{ tier: null }, { tier: { notIn: ['c', 'd'] } }] },
      },
      select: {
        id: true,
        gameId: true,
        status: true,
        forfeit: true,
        beginAt: true,
        scheduledAt: true,
        statsFailureKind: true,
        teamAId: true,
        teamBId: true,
        gamesSummary: true,
        _count: { select: { stats: true } },
        stats: { select: { perMap: true } },
      },
    });
    const dayMatches = candidates.filter((match) => {
      const start = match.beginAt ?? match.scheduledAt;
      return start && parisDate(start) === date;
    });
    const pending = dayMatches.filter(
      (match) => match.status !== 'finished' && match.status !== 'canceled',
    );
    const finished = dayMatches.filter((match) => match.status === 'finished' && !match.forfeit);
    const missing = finished.filter(
      (match) => match._count.stats === 0 && match.statsFailureKind !== 'no-coverage',
    );
    // Match fini AVEC des stats mais incohérentes (map absente, roster ou
    // manches tronqués : fetch prématuré figé) : la journée ne doit pas être
    // tenue pour complète, sinon elle gèlerait sur des données partielles avant
    // la correction. Le gel dur J+3 reste le garde-fou (côté scoring).
    const incoherent = finished.filter(
      (match) => match._count.stats > 0 && !evaluerCoherence(match, match.stats).coherent,
    );
    return {
      date,
      totalMatches: dayMatches.length,
      pendingCount: pending.length,
      missingCount: missing.length,
      incoherentCount: incoherent.length,
      complete: pending.length === 0 && missing.length === 0 && incoherent.length === 0,
      /** Matchs finis avec stats : à re-noter une dernière fois avant le gel. */
      scoredMatchIds: finished.filter((match) => match._count.stats > 0).map((match) => match.id),
      /**
       * Joueurs dont un match du jour n'a AUCUNE stat. Un trou de récupération
       * ne doit pas être imputé au joueur, donc au manager qui l'a pické : le
       * scoring les écarte de la moyenne au lieu de leur compter 0. À ne pas
       * confondre avec un joueur resté sur le banc, dont le match, lui, est
       * bien récupéré.
       *
       * Calculé à la demande : seul le calcul des scores de roster s'en sert,
       * alors que le gel des journées appelle cette méthode dix fois par cycle.
       */
      uncoveredPlayerIds: avecNonCouverts ? await this.playersOfUncoveredMatches(finished) : [],
    };
  }

  /** Titulaires des équipes engagées dans un match fini sans la moindre stat. */
  private async playersOfUncoveredMatches(
    finished: Array<{ teamAId: string | null; teamBId: string | null; _count: { stats: number } }>,
  ): Promise<string[]> {
    const teamIds = [
      ...new Set(
        finished
          .filter((match) => match._count.stats === 0)
          .flatMap((match) => [match.teamAId, match.teamBId])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (teamIds.length === 0) return [];
    const players = await this.prisma.player.findMany({
      where: { teamId: { in: teamIds } },
      select: { id: true },
    });
    return players.map((player) => player.id);
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
        endAt: { gte: new Date(Date.now() - FENETRE_ARBITRAGE_MS) },
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
    const teamIds = [...new Set(matches.flatMap((match) => [match.teamAId, match.teamBId]))].filter(
      (id): id is string => Boolean(id),
    );
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
        namesBySide.set(candidate.side, [
          ...(namesBySide.get(candidate.side) ?? []),
          candidate.name,
        ]);
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
   * seuls). Les matchs que la source ne référence pas (`no-coverage`) sont
   * écartés : les réenfiler à chaque passage coûte une résolution complète pour
   * un échec certain. `null` = fantasy-service injoignable : on ne tente rien
   * plutôt que tout.
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
        NOT: { statsFailureKind: 'no-coverage' },
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
      throw new BadRequestException(
        'URL VLR.gg invalide (attendu : lien, chemin, ou id de match).',
      );
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

  /**
   * Équipes LoL/Valorant sans identité provider : elles n'ont ni roster
   * spécialisé (Leaguepedia/VLR) ni enrichissement de fiche, et leur matching
   * de stats repose sur le seul nom Pandascore. Seuls ces deux jeux exposent
   * une fiche équipe chez la source — Grid (CS2) n'en a pas, ses équipes sont
   * donc hors périmètre. Triées par volume de matchs : le plus pénalisant d'abord.
   */
  async teamsWithoutProviderId(): Promise<
    Array<{
      id: string;
      gameId: string;
      name: string;
      acronym: string | null;
      aliases: string[];
      players: number;
      matches: number;
    }>
  > {
    const teams = await this.prisma.team.findMany({
      where: {
        gameId: { in: ['lol', 'valorant'] },
        OR: [{ providerIds: { equals: Prisma.DbNull } }, { providerIds: { equals: {} } }],
      },
    });
    const rows = await Promise.all(
      teams.map(async (team) => ({
        id: team.id,
        gameId: team.gameId,
        name: team.name,
        acronym: team.acronym,
        aliases: team.aliases ?? [],
        players: await this.prisma.player.count({ where: { teamId: team.id } }),
        matches: await this.prisma.match.count({
          where: { OR: [{ teamAId: team.id }, { teamBId: team.id }] },
        }),
      })),
    );
    return rows.sort((a, b) => b.matches - a.matches);
  }

  /**
   * Fusionne les fiches joueur en double. Rien ne dédoublonne les fiches en
   * base (`pandascoreId` est le seul unique, et il est nul sur toutes les
   * fiches créées par un provider), et le contrôle d'existence de l'ingestion
   * se fait en mémoire : deux jobs concurrents sur la même équipe créent donc
   * la même fiche deux fois, fragmentant l'historique de stats du joueur.
   *
   * `same-team` regroupe sur (jeu, équipe, pseudo normalisé) : aucune
   * ambiguïté possible, c'est le même joueur. `cross-team` regroupe sur
   * (jeu, pseudo normalisé) toutes équipes confondues — un transfert ou une
   * confusion équipe principale/académie — et doit être relu avant d'être
   * appliqué, d'où le `dryRun`.
   */
  async mergeDuplicatePlayers(
    scope: 'same-team' | 'cross-team' | 'same-person',
    dryRun: boolean,
  ): Promise<{
    scope: string;
    dryRun: boolean;
    groupes: number;
    fichesAbsorbees: number;
    statsDeplacees: number;
    details: Array<{ gameId: string; garde: string; absorbees: string[]; stats: number }>;
    /** Couples fiche gardée / fiches absorbées : les notes doivent suivre. */
    fusions: Array<{ garde: string; absorbees: string[] }>;
  }> {
    const players = await this.prisma.player.findMany({
      select: {
        id: true,
        gameId: true,
        teamId: true,
        name: true,
        pandascoreId: true,
        firstName: true,
        lastName: true,
      },
    });
    const statCounts = await this.prisma.playerMatchStats.groupBy({
      by: ['playerId'],
      _count: { _all: true },
    });
    const statsByPlayer = new Map(statCounts.map((row) => [row.playerId, row._count._all]));

    // Clé de regroupement : l'équipe n'entre en jeu que sur le scope prudent ;
    // `same-person` regroupe sur l'identité civile, puis découpe par proximité
    // de pseudo (cf. `clustersParPseudo`).
    const groups = new Map<string, typeof players>();
    for (const player of players) {
      const key = normalizeName(player.name);
      if (!key) continue;
      let groupKey: string;
      if (scope === 'same-team') {
        groupKey = `${player.gameId}|${player.teamId ?? ''}|${key}`;
      } else if (scope === 'same-person') {
        const civil = identiteCivile(player.firstName, player.lastName);
        if (!civil) continue; // sans nom civil complet, aucun rapprochement
        groupKey = `${player.gameId}|${civil}`;
      } else {
        groupKey = `${player.gameId}|${key}`;
      }
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), player]);
    }

    // Un nom civil peut être porté par deux personnes distinctes (« Kim
    // Min-seong » est très répandu) : on ne fusionne que les fiches dont les
    // pseudos se rejoignent, les autres restent séparées.
    const aFusionner =
      scope === 'same-person'
        ? [...groups.values()].flatMap((group) => clustersParPseudo(group))
        : [...groups.values()];

    const details: Array<{ gameId: string; garde: string; absorbees: string[]; stats: number }> =
      [];
    let fichesAbsorbees = 0;
    let statsDeplacees = 0;
    // Fusions réalisées : leurs notes fantasy doivent suivre la fiche gardée.
    const fusions: Array<{ garde: string; absorbees: string[] }> = [];

    for (const group of aFusionner) {
      if (group.length < 2) continue;
      // Fiche gardée : celle qui porte déjà l'identité Pandascore (elle est la
      // référence du reste du système), sinon la plus fournie en stats.
      const sorted = [...group].sort((a, b) => {
        if ((a.pandascoreId != null) !== (b.pandascoreId != null))
          return a.pandascoreId != null ? -1 : 1;
        return (statsByPlayer.get(b.id) ?? 0) - (statsByPlayer.get(a.id) ?? 0);
      });
      const [keep, ...absorbed] = sorted;
      // Deux fiches Pandascore distinctes dans un même groupe = deux joueurs
      // réellement différents chez la source (homonymes), on ne touche à rien.
      if (absorbed.some((player) => player.pandascoreId != null)) continue;

      const moved = absorbed.reduce((sum, player) => sum + (statsByPlayer.get(player.id) ?? 0), 0);
      details.push({
        gameId: keep.gameId,
        garde: `${keep.name} (${keep.id}${keep.pandascoreId ? `, ps ${keep.pandascoreId}` : ''})`,
        absorbees: absorbed.map((player) => `${player.name} (${player.id})`),
        stats: moved,
      });
      fichesAbsorbees += absorbed.length;
      statsDeplacees += moved;
      if (dryRun) continue;

      const absorbees = absorbed.map((player) => player.id);
      await this.mergePlayerInto(keep.id, absorbees);
      fusions.push({ garde: keep.id, absorbees });
    }

    return {
      scope,
      dryRun,
      groupes: details.length,
      fichesAbsorbees,
      statsDeplacees,
      details,
      fusions,
    };
  }

  /**
   * Rapatrie stats et identités provider des fiches absorbées vers la fiche
   * gardée, puis les supprime. Une ligne de stats déjà présente sur la fiche
   * gardée pour le même match l'emporte (`@@unique([matchId, playerId])` ne
   * tolère pas le doublon) : la ligne de la fiche absorbée est supprimée.
   */
  private async mergePlayerInto(keepId: string, absorbedIds: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await reassignPlayerStats(tx, keepId, absorbedIds);

      // Identités provider : l'union, la fiche gardée fait foi en cas de conflit.
      const all = await tx.player.findMany({
        where: { id: { in: [keepId, ...absorbedIds] } },
        select: { id: true, providerIds: true },
      });
      const merged: Record<string, string> = {};
      for (const player of all.filter((p) => p.id !== keepId)) {
        Object.assign(merged, (player.providerIds as Record<string, string> | null) ?? {});
      }
      Object.assign(
        merged,
        (all.find((p) => p.id === keepId)?.providerIds as Record<string, string> | null) ?? {},
      );

      // `active` n'est PAS touché : il appartient à la réconciliation de roster
      // (lineups des matchs, sources de titulaires). Le forcer ici ressuscitait
      // un joueur correctement sorti du cinq, à chaque passage de fusion.
      await tx.player.update({
        where: { id: keepId },
        data: { providerIds: Object.keys(merged).length > 0 ? merged : Prisma.DbNull },
      });
      await tx.player.deleteMany({ where: { id: { in: absorbedIds } } });
    });
  }

  /**
   * Rapprochements Pandascore ambigus en attente d'arbitrage, avec la fiche
   * locale et son équipe pour que l'admin puisse trancher sur pièces.
   */
  async listPlayerAdoptions(): Promise<
    Array<{
      playerId: string;
      name: string;
      gameId: string;
      teamName: string | null;
      candidates: unknown;
    }>
  > {
    const entries = await this.prisma.playerAdoptionCandidate.findMany({
      orderBy: { createdAt: 'asc' },
    });
    if (entries.length === 0) return [];
    const players = await this.prisma.player.findMany({
      where: { id: { in: entries.map((entry) => entry.playerId) } },
      select: { id: true, name: true, gameId: true, team: { select: { name: true } } },
    });
    const byId = new Map(players.map((player) => [player.id, player]));
    return entries.flatMap((entry) => {
      const player = byId.get(entry.playerId);
      if (!player) return [];
      return [
        {
          playerId: entry.playerId,
          name: player.name,
          gameId: player.gameId,
          teamName: player.team?.name ?? null,
          candidates: entry.candidates,
        },
      ];
    });
  }

  /** Écarte un cas ambigu : aucun candidat ne correspond, on n'y revient plus. */
  async dismissPlayerAdoption(playerId: string): Promise<{ dismissed: boolean }> {
    const { count } = await this.prisma.playerAdoptionCandidate.deleteMany({ where: { playerId } });
    return { dismissed: count > 0 };
  }

  /** Équipe par id, ou 404. */
  async getTeam(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException(`Équipe inconnue : ${teamId}`);
    return team;
  }

  /**
   * Fixe l'identité provider d'une équipe (saisie admin déjà résolue ET validée
   * contre la fiche source par `resolveTeamProviderId`). Renvoie les matchs à
   * ré-ingérer : l'id débloque le rapprochement des stats en plus du roster.
   */
  async setTeamProviderId(
    teamId: string,
    source: string,
    providerTeamId: string,
  ): Promise<{ providerIds: Record<string, string>; matchIds: string[] }> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException(`Équipe inconnue : ${teamId}`);
    const current = (team.providerIds as Record<string, string> | null) ?? {};
    const providerIds = { ...current, [source]: providerTeamId };
    await this.prisma.team.update({ where: { id: teamId }, data: { providerIds } });
    return { providerIds, matchIds: await this.statlessMatchIdsForTeam(teamId) };
  }

  /**
   * Matchs finis de l'équipe restés sans aucune ligne de stats. Contrairement à
   * l'ajout d'alias (fenêtre 7 jours), poser une identité provider débloque
   * tout l'historique : une équipe jamais rapprochée peut traîner des mois de
   * matchs vides. Borné aux 50 plus récents pour ne pas noyer la queue.
   */
  private async statlessMatchIdsForTeam(teamId: string): Promise<string[]> {
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        OR: [{ teamAId: teamId }, { teamBId: teamId }],
        stats: { none: {} },
      },
      select: { id: true },
      orderBy: { beginAt: 'desc' },
      take: 50,
    });
    return matches.map((match) => match.id);
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
        endAt: { gte: new Date(Date.now() - FENETRE_ARBITRAGE_MS) },
        OR: [{ teamAId: teamId }, { teamBId: teamId }],
      },
      select: { id: true },
    });
    return matches.map((match) => match.id);
  }

  /**
   * Santé de l'ingestion pour la page admin, tous jeux confondus : activité
   * (en cours, à venir 24h, finis 48h et leur couverture stats), matchs en
   * cours avec fraîcheur des stats live, catalogue (volumes + rapprochement
   * des ids provider/Pandascore), état des sources de stats, queue BullMQ
   * (échecs détaillés) et alias appris.
   */
  async ingestionHealth(queue: Queue) {
    const now = Date.now();
    const since48h = new Date(now - 48 * 3600 * 1000);
    // Fenêtre large (7 j) pour la couverture par jeu ; le détail des matchs
    // sans stats et l'activité restent sur 48 h.
    const finished7j = await this.prisma.match.findMany({
      where: { status: 'finished', endAt: { gte: new Date(now - 7 * 24 * 3600 * 1000) } },
      select: { id: true, gameId: true, name: true, endAt: true },
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

    // Matchs finis dont la source n'a jamais eu les stats : rien n'est
    // arbitrable là, contrairement aux équipes à rapprocher. Le compteur évite
    // de chercher une action derrière une file d'arbitrage vide.
    const sansRecours = await this.prisma.match.count({
      where: { status: 'finished', statsFailureKind: 'no-coverage', stats: { none: {} } },
    });

    // Borné : au-delà, la liste est un symptôme global (source en panne),
    // pas une liste d'actions unitaires — le compteur par jeu suffit.
    const SANS_STATS_MAX = 100;
    const sansStats = finished
      .filter((match) => !withStats.has(match.id))
      .slice(0, SANS_STATS_MAX)
      .map((match) => ({ ...match, endAt: match.endAt?.toISOString() ?? null }));

    const enCours = running.map((match) => ({
      id: match.id,
      gameId: match.gameId,
      name: match.name,
      beginAt: match.beginAt?.toISOString() ?? null,
      statsMaj: runningStatsMaj.get(match.id)?.toISOString() ?? null,
    }));

    // Catalogue par jeu : volumes + rapprochement des identités (combien
    // d'équipes/joueurs ont leur id provider, combien de joueurs leur id
    // Pandascore — les fiches naissent côté provider et sont adoptées ensuite).
    const countByGame = (rows: Array<{ gameId: string; _count: { _all: number } }>) =>
      new Map(rows.map((row) => [row.gameId, row._count._all]));
    const notNullJson = { NOT: { providerIds: { equals: Prisma.DbNull } } } as const;
    const [
      competitionsByGame,
      teamsByGame,
      teamsWithProviderId,
      playersByGame,
      playersWithProviderId,
      playersWithPandascoreId,
    ] = await Promise.all([
      this.prisma.competition.groupBy({ by: ['gameId'], _count: { _all: true } }).then(countByGame),
      this.prisma.team.groupBy({ by: ['gameId'], _count: { _all: true } }).then(countByGame),
      this.prisma.team
        .groupBy({ by: ['gameId'], where: notNullJson, _count: { _all: true } })
        .then(countByGame),
      this.prisma.player.groupBy({ by: ['gameId'], _count: { _all: true } }).then(countByGame),
      this.prisma.player
        .groupBy({ by: ['gameId'], where: notNullJson, _count: { _all: true } })
        .then(countByGame),
      this.prisma.player
        .groupBy({ by: ['gameId'], where: { pandascoreId: { not: null } }, _count: { _all: true } })
        .then(countByGame),
    ]);
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
          equipes: teamsByGame.get(gameId) ?? 0,
          equipesAvecIdProvider: teamsWithProviderId.get(gameId) ?? 0,
          joueurs: playersByGame.get(gameId) ?? 0,
          joueursAvecIdProvider: playersWithProviderId.get(gameId) ?? 0,
          joueursAvecIdPandascore: playersWithPandascoreId.get(gameId) ?? 0,
        },
      ]),
    );

    // État des sources de stats détaillées (clé configurée côté service).
    const sources = [
      { gameId: 'cs2', source: 'bo3.gg', configuree: true, live: true },
      { gameId: 'valorant', source: 'VLR.gg', configuree: true, live: true },
      { gameId: 'lol', source: 'Leaguepedia', configuree: true, live: false },
    ];

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
      /** Matchs finis que la source n'a jamais eus : aucun arbitrage possible. */
      sansRecours,
      queue: { ...counts, echecs },
      aliases,
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
      (await this.prisma.match.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
        (match) => match.id,
      ),
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
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
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
