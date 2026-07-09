/**
 * Décision pure du retrait d'un membre d'une ligue (kick ou départ),
 * testable sans base. L'exécution (suppressions, transfert) reste dans le
 * service.
 */

export interface MemberInfo {
  userId: string;
  joinedAt: Date;
}

export type RemovalDecision =
  | { kind: 'forbidden'; reason: string }
  /** Le owner retire un autre membre. */
  | { kind: 'kick' }
  /** Un membre quitte la ligue de lui-même. */
  | { kind: 'quit' }
  /** Le owner part : la ligue est transférée au plus ancien autre membre. */
  | { kind: 'quit-transfer'; heirUserId: string }
  /** Le owner part et il était seul : la ligue est supprimée. */
  | { kind: 'quit-delete' };

export function decideMemberRemoval(
  actorId: string,
  targetId: string,
  ownerId: string,
  members: MemberInfo[],
): RemovalDecision {
  if (!members.some((member) => member.userId === targetId)) {
    return { kind: 'forbidden', reason: 'Ce membre ne fait pas partie de la ligue' };
  }

  if (actorId !== targetId) {
    if (actorId !== ownerId) {
      return { kind: 'forbidden', reason: 'Seul le créateur peut exclure un membre' };
    }
    if (targetId === ownerId) {
      return { kind: 'forbidden', reason: 'Le créateur ne peut pas être exclu' };
    }
    return { kind: 'kick' };
  }

  if (targetId !== ownerId) {
    return { kind: 'quit' };
  }

  const heir = members
    .filter((member) => member.userId !== ownerId)
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
  return heir ? { kind: 'quit-transfer', heirUserId: heir.userId } : { kind: 'quit-delete' };
}
