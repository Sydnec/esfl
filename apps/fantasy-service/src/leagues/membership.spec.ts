import { describe, expect, it } from 'vitest';
import { decideMemberRemoval } from './membership';

const OWNER = 'owner';
const MEMBER = 'membre';
const OTHER = 'autre';

function members(...userIds: string[]) {
  return userIds.map((userId, index) => ({
    userId,
    joinedAt: new Date(2026, 0, index + 1),
  }));
}

describe('decideMemberRemoval', () => {
  it('le owner exclut un membre', () => {
    expect(decideMemberRemoval(OWNER, MEMBER, OWNER, members(OWNER, MEMBER))).toEqual({
      kind: 'kick',
    });
  });

  it('un membre ne peut pas exclure quelqu’un', () => {
    const decision = decideMemberRemoval(MEMBER, OTHER, OWNER, members(OWNER, MEMBER, OTHER));
    expect(decision.kind).toBe('forbidden');
  });

  it('le owner ne peut pas être exclu', () => {
    const decision = decideMemberRemoval(OWNER, OWNER, OWNER, members(OWNER, MEMBER));
    // Le owner se retire lui-même : transfert, pas une exclusion refusée.
    expect(decision).toEqual({ kind: 'quit-transfer', heirUserId: MEMBER });
  });

  it('un membre exclu doit appartenir à la ligue', () => {
    const decision = decideMemberRemoval(OWNER, 'inconnu', OWNER, members(OWNER, MEMBER));
    expect(decision.kind).toBe('forbidden');
  });

  it('un membre quitte la ligue', () => {
    expect(decideMemberRemoval(MEMBER, MEMBER, OWNER, members(OWNER, MEMBER))).toEqual({
      kind: 'quit',
    });
  });

  it('un membre ne peut pas viser le owner', () => {
    const decision = decideMemberRemoval(MEMBER, OWNER, OWNER, members(OWNER, MEMBER));
    expect(decision.kind).toBe('forbidden');
  });

  it('le owner part : transfert au plus ancien membre restant', () => {
    const decision = decideMemberRemoval(OWNER, OWNER, OWNER, members(OWNER, MEMBER, OTHER));
    expect(decision).toEqual({ kind: 'quit-transfer', heirUserId: MEMBER });
  });

  it('le owner part seul : suppression de la ligue', () => {
    expect(decideMemberRemoval(OWNER, OWNER, OWNER, members(OWNER))).toEqual({
      kind: 'quit-delete',
    });
  });
});
