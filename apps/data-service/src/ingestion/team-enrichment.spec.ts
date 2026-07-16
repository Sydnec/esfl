import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import type { IngestionService } from './ingestion.service';
import type { VlrStatsProvider } from '../stats/vlr.provider';
import type { LeaguepediaStatsProvider } from '../stats/leaguepedia.provider';
import type { TeamProfile, TeamSearchResult } from '../stats/provider';
import { TeamEnrichmentService } from './team-enrichment.service';

/**
 * Tests de l'enrichissement d'équipe : résolution proactive stricte, précédence
 * provider > Pandascore, conservation du nom Pandascore en alias, garde-fou
 * anti-vol d'identité et application du roster lu au passage.
 */

function setup(opts: {
  team: Record<string, unknown> | null;
  otherTeams?: Array<{ name: string; aliases: string[] }>;
  searchResult?: TeamSearchResult | null;
  profile?: TeamProfile | null;
}) {
  const teamUpdates: Array<Record<string, unknown>> = [];
  const prisma = {
    team: {
      findUnique: vi.fn(async () => opts.team),
      findMany: vi.fn(async () => opts.otherTeams ?? []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        teamUpdates.push(data);
        return data;
      }),
    },
  } as unknown as PrismaService;
  const applyStarterRoster = vi.fn(async () => undefined);
  const ingestion = { applyStarterRoster } as unknown as IngestionService;
  const vlr = {
    source: 'vlr',
    gameId: 'valorant',
    searchTeam: vi.fn(async () => opts.searchResult ?? null),
    fetchTeamProfile: vi.fn(async () => opts.profile ?? null),
  } as unknown as VlrStatsProvider;
  const leaguepedia = { source: 'leaguepedia', gameId: 'lol' } as LeaguepediaStatsProvider;
  const service = new TeamEnrichmentService(prisma, ingestion, vlr, leaguepedia);
  return { service, teamUpdates, applyStarterRoster, vlr };
}

const baseTeam = {
  id: 'team-a',
  gameId: 'valorant',
  name: 'Gen.G',
  aliases: [],
  providerIds: null,
  fieldSources: null,
};

describe('enrichTeam', () => {
  it('recherche ambiguë/introuvable → no-op (on attend un match résolu)', async () => {
    const { service, teamUpdates, vlr } = setup({ team: baseTeam, searchResult: null });
    await service.enrichTeam('team-a');
    expect(teamUpdates).toHaveLength(0);
    expect(vlr.fetchTeamProfile).not.toHaveBeenCalled();
  });

  it('applique la fiche provider avec précédence et garde l’ancien nom en alias', async () => {
    const { service, teamUpdates } = setup({
      team: baseTeam,
      searchResult: { id: '1184', name: 'Gen.G' },
      profile: { name: 'Gen.G Esports', acronym: 'GEN', imageUrl: 'vlr.png', location: 'KR' },
    });
    await service.enrichTeam('team-a');
    // 1er update : l'id provider appris par la recherche.
    expect(teamUpdates[0]).toEqual({ providerIds: { vlr: '1184' } });
    // 2e update : la fiche, possédée champ par champ, ancien nom en alias.
    // Le logo provider n'est jamais revendiqué : Pandascore reste la référence.
    expect(teamUpdates[1]).toMatchObject({
      name: 'Gen.G Esports',
      acronym: 'GEN',
      location: 'KR',
      fieldSources: { name: 'vlr', acronym: 'vlr', location: 'vlr' },
      aliases: ['Gen.G'],
    });
    expect(teamUpdates[1]).not.toHaveProperty('imageUrl');
  });

  it('un logo revendiqué par un enrichissement antérieur est libéré (retour Pandascore)', async () => {
    const { service, teamUpdates } = setup({
      team: {
        ...baseTeam,
        providerIds: { vlr: '1184' },
        imageUrl: 'https://banniere.png',
        fieldSources: { imageUrl: 'vlr' },
      },
      profile: { acronym: 'GEN', imageUrl: 'https://banniere.png' },
    });
    await service.enrichTeam('team-a');
    expect(teamUpdates[0]).toMatchObject({ acronym: 'GEN', imageUrl: null });
    expect((teamUpdates[0].fieldSources as Record<string, string>).imageUrl).toBeUndefined();
  });

  it('id provider déjà connu : pas de recherche, fiche directement', async () => {
    const { service, vlr, teamUpdates } = setup({
      team: { ...baseTeam, providerIds: { vlr: '1184' } },
      profile: { acronym: 'GEN' },
    });
    await service.enrichTeam('team-a');
    expect(vlr.searchTeam).not.toHaveBeenCalled();
    expect(teamUpdates[0]).toMatchObject({ acronym: 'GEN', fieldSources: { acronym: 'vlr' } });
  });

  it('fiche au nom d’une autre équipe connue → abandon (anti-vol d’identité)', async () => {
    const { service, teamUpdates } = setup({
      team: { ...baseTeam, providerIds: { vlr: '1184' } },
      otherTeams: [{ name: 'Gen.G Global Academy', aliases: ['GnG Academy'] }],
      profile: { name: 'GnG Academy' },
    });
    await service.enrichTeam('team-a');
    expect(teamUpdates).toHaveLength(0);
  });

  it('le garde anti-vol exige l’égalité exacte (« T1 » passe malgré « T1 Academy »)', async () => {
    const { service, teamUpdates } = setup({
      team: { ...baseTeam, name: 'T1 Esports Academy', providerIds: { vlr: '99' } },
      otherTeams: [{ name: 'T1 Academy', aliases: [] }],
      profile: { name: 'T1' },
    });
    await service.enrichTeam('team-a');
    expect(teamUpdates[0]).toMatchObject({ name: 'T1' });
  });

  it('roster lu au passage : appliqué via applyStarterRoster', async () => {
    const { service, applyStarterRoster } = setup({
      team: { ...baseTeam, providerIds: { vlr: '1184' } },
      profile: { acronym: 'GEN', roster: [{ name: 'Meteor', externalId: '9' }] },
    });
    await service.enrichTeam('team-a');
    expect(applyStarterRoster).toHaveBeenCalledWith(expect.anything(), [
      { name: 'Meteor', externalId: '9' },
    ]);
  });
});
