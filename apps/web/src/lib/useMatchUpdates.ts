'use client';

import { useEffect, useRef } from 'react';
import { API_URL } from './api';

export interface MatchUpdate {
  matchId: string;
  gameId: string;
}

/**
 * Écoute le flux SSE des mises à jour de matchs (`/data/live/stream`) et
 * rappelle `onUpdate` à chaque changement (score, statut, stats ingérées).
 * EventSource se reconnecte tout seul ; le polling existant des pages reste
 * en filet de sécurité.
 */
export function useMatchUpdates(onUpdate: (update: MatchUpdate) => void): void {
  // Ref pour que la connexion SSE survive aux re-render sans se recréer.
  const handler = useRef(onUpdate);
  handler.current = onUpdate;

  useEffect(() => {
    const source = new EventSource(`${API_URL}/data/live/stream`);
    source.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data as string) as Partial<MatchUpdate> & {
          type?: string;
        };
        if (data.type === 'match-updated' && data.matchId && data.gameId) {
          handler.current({ matchId: data.matchId, gameId: data.gameId });
        }
      } catch {
        // battement de cœur ou message inattendu : ignoré
      }
    };
    return () => source.close();
  }, []);
}
