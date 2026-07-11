import { Controller, Sse } from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import { LiveEventsService } from './live-events.service';

interface SseMessage {
  data: { type: string; matchId?: string; gameId?: string };
}

/** Battement de cœur : garde la connexion SSE ouverte à travers les proxys. */
const HEARTBEAT_MS = 25_000;

@Controller('data')
export class LiveController {
  constructor(private readonly events: LiveEventsService) {}

  /**
   * Flux SSE public des mises à jour de matchs. Le front écoute et refetch
   * les données concernées — pas de payload métier ici, juste le signal.
   */
  @Sse('live/stream')
  stream(): Observable<SseMessage> {
    const updates = this.events.stream$.pipe(
      map((event) => ({ data: { type: 'match-updated', ...event } })),
    );
    const heartbeat = interval(HEARTBEAT_MS).pipe(map(() => ({ data: { type: 'ping' } })));
    return merge(updates, heartbeat);
  }
}
