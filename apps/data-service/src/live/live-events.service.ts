import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface MatchUpdatedEvent {
  matchId: string;
  gameId: string;
}

/**
 * Bus in-process des mises à jour de matchs (score, statut, stats) : alimenté
 * par l'ingestion, consommé par le flux SSE `/data/live/stream` du front.
 * In-process suffit : une seule instance de data-service écrit ces données.
 */
@Injectable()
export class LiveEventsService {
  private readonly subject = new Subject<MatchUpdatedEvent>();
  readonly stream$ = this.subject.asObservable();

  emitMatchUpdated(event: MatchUpdatedEvent): void {
    this.subject.next(event);
  }
}
