import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AlerteService, doitAlerter } from './alerte.service';

const HEURE = 3600 * 1000;

describe('doitAlerter', () => {
  it('reste muet sous le seuil : le bruit normal ne doit pas alerter', () => {
    // Quelques matchs absents des sources arrivent en permanence.
    for (let n = 0; n < 10; n += 1) expect(doitAlerter(n, undefined, 0)).toBe(false);
  });

  it('alerte au seuil atteint', () => {
    expect(doitAlerter(10, undefined, 0)).toBe(true);
  });

  it('ne réalerte pas dans les six heures', () => {
    expect(doitAlerter(50, 0, 5 * HEURE)).toBe(false);
  });

  it('réalerte au-delà, sur une panne qui dure', () => {
    expect(doitAlerter(50, 0, 6 * HEURE)).toBe(true);
  });
});

function service(url?: string) {
  const config = { get: vi.fn(() => url) } as unknown as ConfigService;
  return new AlerteService(config);
}

afterEach(() => vi.unstubAllGlobals());

describe('AlerteService', () => {
  it('n’envoie rien avant le seuil, puis une seule fois', async () => {
    const envoi = vi.fn(async (_url: string, _init?: { body?: string }) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', envoi);
    const alertes = service('https://discord.test/webhook');

    for (let i = 0; i < 9; i += 1) await alertes.echec('vlr', 'stats indisponibles');
    expect(envoi).not.toHaveBeenCalled();

    await alertes.echec('vlr', 'stats indisponibles');
    expect(envoi).toHaveBeenCalledOnce();

    // La panne continue : pas de nouveau message avant le délai de rappel.
    for (let i = 0; i < 20; i += 1) await alertes.echec('vlr', 'stats indisponibles');
    expect(envoi).toHaveBeenCalledOnce();
  });

  it('un succès réarme complètement la source', async () => {
    const envoi = vi.fn(async (_url: string, _init?: { body?: string }) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', envoi);
    const alertes = service('https://discord.test/webhook');

    for (let i = 0; i < 10; i += 1) await alertes.echec('bo3', 'introuvable');
    expect(envoi).toHaveBeenCalledOnce();

    alertes.succes('bo3');
    for (let i = 0; i < 9; i += 1) await alertes.echec('bo3', 'introuvable');
    expect(envoi).toHaveBeenCalledOnce(); // le compteur est bien reparti de zéro

    await alertes.echec('bo3', 'introuvable');
    expect(envoi).toHaveBeenCalledTimes(2);
  });

  it('compte chaque source séparément', async () => {
    const envoi = vi.fn(async (_url: string, _init?: { body?: string }) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', envoi);
    const alertes = service('https://discord.test/webhook');

    for (let i = 0; i < 9; i += 1) {
      await alertes.echec('vlr', 'x');
      await alertes.echec('bo3', 'x');
    }
    expect(envoi).not.toHaveBeenCalled();
    await alertes.echec('vlr', 'x');
    expect(envoi).toHaveBeenCalledOnce();
  });

  it('sans webhook configuré, ne fait qu’un log et n’échoue pas', async () => {
    const envoi = vi.fn();
    vi.stubGlobal('fetch', envoi);
    const alertes = service(undefined);
    for (let i = 0; i < 12; i += 1) await alertes.echec('vlr', 'x');
    expect(envoi).not.toHaveBeenCalled();
  });

  it('un webhook injoignable ne remonte jamais d’erreur à l’ingestion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('réseau coupé');
      }),
    );
    const alertes = service('https://discord.test/webhook');
    for (let i = 0; i < 10; i += 1) {
      await expect(alertes.echec('vlr', 'x')).resolves.toBeUndefined();
    }
  });

  it('le message porte la source, le compte et le motif', async () => {
    const envoi = vi.fn(async (_url: string, _init?: { body?: string }) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', envoi);
    const alertes = service('https://discord.test/webhook');
    for (let i = 0; i < 10; i += 1) await alertes.echec('leaguepedia', 'MWException');

    const corps = JSON.parse(envoi.mock.calls[0][1]?.body ?? '{}') as { content: string };
    expect(corps.content).toContain('leaguepedia');
    expect(corps.content).toContain('10');
    expect(corps.content).toContain('MWException');
  });
});
