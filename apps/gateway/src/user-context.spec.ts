import { describe, expect, it, vi } from 'vitest';
import { sign } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { bloquerRoutesInternes, contexteUtilisateur } from './user-context';

const SECRET = 'secret-de-test';

function requete(headers: Record<string, string> = {}, path = '/data/matches'): Request {
  return { headers: { ...headers }, path } as unknown as Request;
}

function passe(req: Request, secret = SECRET): Request {
  const next = vi.fn();
  contexteUtilisateur(secret)(req, {} as Response, next as unknown as NextFunction);
  expect(next).toHaveBeenCalledOnce();
  return req;
}

describe('contexteUtilisateur — usurpation', () => {
  it('supprime les x-user-* entrants d’une requête anonyme', () => {
    const req = passe(requete({ 'x-user-id': 'victime', 'x-user-admin': '1' }));
    expect(req.headers['x-user-id']).toBeUndefined();
    expect(req.headers['x-user-admin']).toBeUndefined();
  });

  it('supprime les x-user-* entrants même quand un token valide suit', () => {
    // Le token décide, jamais l'en-tête : l'identité forgée ne doit pas survivre.
    const token = sign({ sub: 'reel' }, SECRET);
    const req = passe(
      requete({ 'x-user-id': 'usurpe', 'x-user-admin': '1', authorization: `Bearer ${token}` }),
    );
    expect(req.headers['x-user-id']).toBe('reel');
    expect(req.headers['x-user-admin']).toBeUndefined();
  });

  it('supprime les x-user-* entrants quand le token est invalide', () => {
    const req = passe(
      requete({
        'x-user-id': 'usurpe',
        'x-user-admin': '1',
        authorization: 'Bearer nimporte-quoi',
      }),
    );
    expect(req.headers['x-user-id']).toBeUndefined();
    expect(req.headers['x-user-admin']).toBeUndefined();
  });
});

describe('contexteUtilisateur — validité du token', () => {
  it('pose x-user-id pour un token valide', () => {
    const req = passe(requete({ authorization: `Bearer ${sign({ sub: 'u1' }, SECRET)}` }));
    expect(req.headers['x-user-id']).toBe('u1');
  });

  it('rejette un token signé avec une autre clé', () => {
    const token = sign({ sub: 'u1', isAdmin: true }, 'une-autre-cle');
    const req = passe(requete({ authorization: `Bearer ${token}` }));
    expect(req.headers['x-user-id']).toBeUndefined();
  });

  it('rejette un token expiré', () => {
    const token = sign({ sub: 'u1' }, SECRET, { expiresIn: -10 });
    const req = passe(requete({ authorization: `Bearer ${token}` }));
    expect(req.headers['x-user-id']).toBeUndefined();
  });

  it('ignore un token sans sujet', () => {
    const req = passe(requete({ authorization: `Bearer ${sign({ isAdmin: true }, SECRET)}` }));
    expect(req.headers['x-user-id']).toBeUndefined();
    expect(req.headers['x-user-admin']).toBeUndefined();
  });

  it('ignore un en-tête Authorization qui n’est pas un Bearer', () => {
    const req = passe(requete({ authorization: `Basic ${sign({ sub: 'u1' }, SECRET)}` }));
    expect(req.headers['x-user-id']).toBeUndefined();
  });
});

describe('contexteUtilisateur — élévation admin', () => {
  it('pose x-user-admin quand isAdmin vaut exactement true', () => {
    const req = passe(
      requete({ authorization: `Bearer ${sign({ sub: 'a', isAdmin: true }, SECRET)}` }),
    );
    expect(req.headers['x-user-admin']).toBe('1');
  });

  it('refuse une claim isAdmin seulement « truthy »', () => {
    // Une comparaison lâche promouvrait admin toute chaîne non vide.
    for (const claim of ['1', 'true', 'yes', 1]) {
      const token = sign({ sub: 'a', isAdmin: claim }, SECRET);
      const req = passe(requete({ authorization: `Bearer ${token}` }));
      expect(req.headers['x-user-admin']).toBeUndefined();
    }
  });

  it('n’élève pas un utilisateur sans claim isAdmin', () => {
    const req = passe(requete({ authorization: `Bearer ${sign({ sub: 'u' }, SECRET)}` }));
    expect(req.headers['x-user-id']).toBe('u');
    expect(req.headers['x-user-admin']).toBeUndefined();
  });
});

describe('bloquerRoutesInternes', () => {
  const reponse = () => {
    const res = { status: vi.fn(), end: vi.fn() };
    res.status.mockReturnValue(res);
    return res as unknown as Response & { status: ReturnType<typeof vi.fn> };
  };

  it('renvoie 404 sur une route interne, sans la proxyfier', () => {
    const res = reponse();
    const next = vi.fn();
    bloquerRoutesInternes(
      requete({}, '/fantasy/internal/rosters'),
      res,
      next as unknown as NextFunction,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('bloque aussi un segment interne imbriqué', () => {
    const res = reponse();
    const next = vi.fn();
    bloquerRoutesInternes(requete({}, '/data/x/internal/y'), res, next as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('laisse passer une route publique', () => {
    const res = reponse();
    const next = vi.fn();
    bloquerRoutesInternes(requete({}, '/data/matches'), res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
