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

/** Cadence du filet de sécurité quand le flux SSE est coupé ou en retard. */
const INTERVALLE_POLLING_MS = 60_000;

/** Deux mises à jour SSE plus rapprochées que ça ne déclenchent qu'un refetch. */
const LISSAGE_SSE_MS = 3_000;

/**
 * Rafraîchissement live d'une page de matchs : polling de sécurité en arrière-
 * plan (suspendu quand l'onglet est caché) et refetch immédiat sur événement
 * SSE, lissé parce qu'un cycle de synchro touche plusieurs matchs d'affilée.
 *
 * `charger` doit être stable (`useCallback`), comme pour tout effet.
 */
export function useRafraichissementLive(charger: () => void | Promise<void>): void {
  const dernier = useRef(0);

  useEffect(() => {
    void charger();
    const interval = setInterval(() => {
      if (!document.hidden) void charger();
    }, INTERVALLE_POLLING_MS);
    return () => clearInterval(interval);
  }, [charger]);

  useMatchUpdates(() => {
    if (Date.now() - dernier.current < LISSAGE_SSE_MS) return;
    dernier.current = Date.now();
    void charger();
  });
}
