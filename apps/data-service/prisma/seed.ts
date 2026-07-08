/**
 * Seed de démo : une compétition fictive par jeu, 2 équipes, joueurs, et
 * 3 matchs (terminé hier avec stats, aujourd'hui, demain).
 * Usage : sourcer le .env racine puis `pnpm --filter @esfl/data-service seed`.
 * Les pandascoreId négatifs évitent toute collision avec l'ingestion réelle.
 */
import { PrismaClient } from '../generated/client';

const prisma = new PrismaClient({ datasourceUrl: process.env.DATA_DATABASE_URL });

type SeedGame = {
  gameId: 'cs2' | 'valorant' | 'lol' | 'rl';
  competition: string;
  rosterSize: number;
  teams: [string, string];
  normalizedStats: () => Record<string, unknown>;
};

const GAMES: SeedGame[] = [
  {
    gameId: 'cs2',
    competition: 'ESFL Demo CS2 Masters',
    rosterSize: 5,
    teams: ['Nexus Five', 'Border Control'],
    normalizedStats: () => ({
      kills: 15 + Math.floor(Math.random() * 15),
      deaths: 10 + Math.floor(Math.random() * 10),
      assists: Math.floor(Math.random() * 8),
      adr: 60 + Math.random() * 40,
      rating: 0.7 + Math.random() * 0.7,
    }),
  },
  {
    gameId: 'valorant',
    competition: 'ESFL Demo Valorant Open',
    rosterSize: 5,
    teams: ['Spike Rush', 'Clutch Kings'],
    normalizedStats: () => ({
      kills: 12 + Math.floor(Math.random() * 15),
      deaths: 10 + Math.floor(Math.random() * 10),
      assists: Math.floor(Math.random() * 10),
      acs: 150 + Math.random() * 150,
      firstKills: Math.floor(Math.random() * 5),
    }),
  },
  {
    gameId: 'lol',
    competition: 'ESFL Demo LoL Cup',
    rosterSize: 5,
    teams: ['Baron Stealers', 'Mid Diff'],
    normalizedStats: () => ({
      kills: Math.floor(Math.random() * 10),
      deaths: Math.floor(Math.random() * 7),
      assists: Math.floor(Math.random() * 15),
      csPerMin: 6 + Math.random() * 4,
      win: Math.random() > 0.5,
    }),
  },
  {
    gameId: 'rl',
    competition: 'ESFL Demo RL Invitational',
    rosterSize: 3,
    teams: ['Aerial Aces', 'Demo Derby'],
    normalizedStats: () => ({
      goals: Math.floor(Math.random() * 4),
      assists: Math.floor(Math.random() * 3),
      saves: Math.floor(Math.random() * 5),
      shots: 2 + Math.floor(Math.random() * 6),
      score: 200 + Math.floor(Math.random() * 600),
    }),
  },
];

let nextId = -1;
function seedId(): number {
  nextId -= 1;
  return nextId;
}

async function main() {
  const dayMs = 24 * 3600 * 1000;
  const now = Date.now();

  for (const [gameIndex, game] of GAMES.entries()) {
    // ids négatifs stables par jeu pour l'idempotence
    nextId = -1000 * (gameIndex + 1);

    const competition = await prisma.competition.upsert({
      where: { pandascoreId: seedId() },
      create: {
        pandascoreId: nextId,
        gameId: game.gameId,
        name: game.competition,
        slug: game.competition.toLowerCase().replace(/\s+/g, '-'),
        tier: 'demo',
        beginAt: new Date(now - 7 * dayMs),
        endAt: new Date(now + 21 * dayMs),
      },
      update: {},
    });

    const teamIds: string[] = [];
    const playersByTeam: string[][] = [];
    for (const teamName of game.teams) {
      const team = await prisma.team.upsert({
        where: { pandascoreId: seedId() },
        create: {
          pandascoreId: nextId,
          gameId: game.gameId,
          name: teamName,
          acronym: teamName
            .split(' ')
            .map((word) => word[0])
            .join('')
            .toUpperCase(),
        },
        update: {},
      });
      teamIds.push(team.id);
      await prisma.competitionTeam.upsert({
        where: { competitionId_teamId: { competitionId: competition.id, teamId: team.id } },
        create: { competitionId: competition.id, teamId: team.id },
        update: {},
      });

      const playerIds: string[] = [];
      for (let i = 1; i <= game.rosterSize; i += 1) {
        const player = await prisma.player.upsert({
          where: { pandascoreId: seedId() },
          create: {
            pandascoreId: nextId,
            gameId: game.gameId,
            name: `${team.acronym}_player${i}`,
            teamId: team.id,
          },
          update: { teamId: team.id },
        });
        playerIds.push(player.id);
      }
      playersByTeam.push(playerIds);
    }

    const matchDefs = [
      { offset: -1 * dayMs, status: 'finished' },
      { offset: 6 * 3600 * 1000, status: 'not_started' },
      { offset: dayMs + 6 * 3600 * 1000, status: 'not_started' },
    ];
    for (const def of matchDefs) {
      const scheduledAt = new Date(now + def.offset);
      const finished = def.status === 'finished';
      const scoreA = finished ? 2 : null;
      const scoreB = finished ? 1 : null;
      const match = await prisma.match.upsert({
        where: { pandascoreId: seedId() },
        create: {
          pandascoreId: nextId,
          gameId: game.gameId,
          competitionId: competition.id,
          name: `${game.teams[0]} vs ${game.teams[1]}`,
          status: def.status,
          scheduledAt,
          beginAt: finished ? scheduledAt : null,
          endAt: finished ? new Date(scheduledAt.getTime() + 2 * 3600 * 1000) : null,
          teamAId: teamIds[0],
          teamBId: teamIds[1],
          scoreA,
          scoreB,
          winnerTeamId: finished ? teamIds[0] : null,
        },
        update: {},
      });

      if (finished) {
        for (const playerId of playersByTeam.flat()) {
          const normalized = game.normalizedStats();
          await prisma.playerMatchStats.upsert({
            where: { matchId_playerId: { matchId: match.id, playerId } },
            create: {
              matchId: match.id,
              playerId,
              gameId: game.gameId,
              source: 'seed',
              raw: normalized,
              normalized,
            },
            update: {},
          });
        }
      }
    }
    console.log(`✓ seed ${game.gameId} : ${game.competition}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
