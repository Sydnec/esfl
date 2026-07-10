import type { GameId } from '@esfl/contracts';

/**
 * Icône d'agent/champion : fichiers locaux (public/agents) pour Valorant —
 * on ne hotlinke pas vlr.gg — sinon l'URL fournie par le provider
 * (CommunityDragon pour LoL, CDN prévu pour ça).
 */
export function agentIconSrc(
  gameId: GameId,
  entry: { agent: string | null; agentImage?: string | null },
): string | null {
  if (gameId === 'valorant' && entry.agent) {
    return `/agents/${entry.agent.toLowerCase().replace(/[^a-z0-9]/g, '')}.png`;
  }
  return entry.agentImage ?? null;
}
