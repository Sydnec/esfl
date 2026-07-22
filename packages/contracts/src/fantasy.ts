import { z } from 'zod';

export const createLeagueInputSchema = z.object({
  name: z.string().min(3).max(40),
  /** Nombre de joueurs à aligner par journée. */
  rosterSize: z.number().int().min(1).max(10).default(5),
  /** N : nombre de journées de verrouillage après un pick. */
  lockMatchDays: z.number().int().min(0).max(10).default(2),
  /** Compétitions suivies (ids du référentiel data-service). */
  competitionIds: z.array(z.string()).min(1),
});
export type CreateLeagueInput = z.infer<typeof createLeagueInputSchema>;

export const joinLeagueInputSchema = z.object({
  inviteCode: z.string().min(4).max(16),
});
export type JoinLeagueInput = z.infer<typeof joinLeagueInputSchema>;

export const addCompetitionInputSchema = z.object({
  competitionId: z.string().min(1),
});
export type AddCompetitionInput = z.infer<typeof addCompetitionInputSchema>;

/** Réglages modifiables d'une ligue (owner). Au moins un champ requis. */
export const updateLeagueInputSchema = z
  .object({
    name: z.string().min(3).max(40).optional(),
    rosterSize: z.number().int().min(1).max(10).optional(),
    lockMatchDays: z.number().int().min(0).max(10).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Aucun champ à modifier',
  });
export type UpdateLeagueInput = z.infer<typeof updateLeagueInputSchema>;

export const submitRosterInputSchema = z.object({
  playerIds: z.array(z.string().min(1)).min(1).max(10),
});
export type SubmitRosterInput = z.infer<typeof submitRosterInputSchema>;

/**
 * Échéance dure du gel d'une journée, en jours : passé ce délai le scoring fige
 * la journée avec les données disponibles, complètes ou non.
 *
 * Partagée parce qu'elle borne aussi l'ingestion : chercher les stats d'un
 * match au-delà est sans objet, la note ne peut plus changer. Les deux services
 * doivent bouger ensemble, d'où la constante commune.
 */
export const FREEZE_DEADLINE_DAYS = 3;
