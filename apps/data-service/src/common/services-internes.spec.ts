import { describe, expect, it } from 'vitest';
import { verifierUrlsServices } from '@esfl/contracts';

// Le garde-fou vit dans @esfl/contracts, partagé par les cinq services, qui n'a
// pas de runner de tests : on le couvre ici, chez l'appelant que l'oubli d'URL a
// réellement cassé (jobs `players-merged` en `fetch failed`).
describe('verifierUrlsServices', () => {
  const prod = { NODE_ENV: 'production' };

  it('laisse démarrer quand les URL attendues sont fournies', () => {
    expect(() =>
      verifierUrlsServices(['SCORING_SERVICE_URL'], {
        ...prod,
        SCORING_SERVICE_URL: 'http://scoring-service:4004',
      }),
    ).not.toThrow();
  });

  it('refuse de démarrer en production si une URL manque', () => {
    expect(() => verifierUrlsServices(['FANTASY_SERVICE_URL'], prod)).toThrow(
      /FANTASY_SERVICE_URL/,
    );
  });

  it('traite une valeur vide comme absente', () => {
    expect(() =>
      verifierUrlsServices(['DATA_SERVICE_URL'], { ...prod, DATA_SERVICE_URL: '  ' }),
    ).toThrow(/DATA_SERVICE_URL/);
  });

  it('les signale toutes d’un coup plutôt qu’une par redémarrage', () => {
    expect(() =>
      verifierUrlsServices(['FANTASY_SERVICE_URL', 'SCORING_SERVICE_URL'], prod),
    ).toThrow(/FANTASY_SERVICE_URL, SCORING_SERVICE_URL/);
  });

  it('hors production, le repli localhost reste légitime : aucun échec', () => {
    expect(() =>
      verifierUrlsServices(['SCORING_SERVICE_URL'], { NODE_ENV: 'development' }),
    ).not.toThrow();
  });
});
