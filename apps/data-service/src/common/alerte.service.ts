import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Nombre d'échecs CONSÉCUTIFS sur une même source avant d'alerter.
 *
 * Le seuil, et non un échec isolé, est ce qui distingue une panne du bruit
 * normal : il y a toujours quelques matchs que les sources ne référencent pas,
 * mais ils s'intercalent entre des succès. Un parser qui casse — VLR change son
 * HTML, un champ Cargo disparaît — fait au contraire échouer TOUT ce qui suit.
 */
const SEUIL_ECHECS = 10;

/** Délai avant de réalerter sur une panne qui dure, pour ne pas inonder. */
const RAPPEL_MS = 6 * 3600 * 1000;

/** Décision d'alerte, isolée du réseau pour être testable. */
export function doitAlerter(
  consecutifs: number,
  derniereAlerte: number | undefined,
  maintenant: number,
): boolean {
  if (consecutifs < SEUIL_ECHECS) return false;
  if (derniereAlerte === undefined) return true;
  return maintenant - derniereAlerte >= RAPPEL_MS;
}

/**
 * Alerte sur les pannes de source d'ingestion, via un webhook Discord.
 *
 * Un parser qui casse ne lève pas d'exception : il rend zéro ligne, le job part
 * en retry et la couverture s'effrite en silence. Seule la répétition le
 * signale, d'où le compteur d'échecs consécutifs remis à zéro par le moindre
 * succès.
 *
 * Sans `DISCORD_ALERT_WEBHOOK_URL`, le service se contente de journaliser :
 * l'absence de configuration ne doit jamais faire échouer une ingestion.
 */
@Injectable()
export class AlerteService {
  private readonly logger = new Logger(AlerteService.name);
  private readonly consecutifs = new Map<string, number>();
  private readonly derniereAlerte = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  /** Un succès innocente la source : le compteur et l'alerte sont réarmés. */
  succes(source: string): void {
    if (this.consecutifs.get(source)) {
      this.consecutifs.delete(source);
      this.derniereAlerte.delete(source);
    }
  }

  async echec(source: string, detail: string): Promise<void> {
    const consecutifs = (this.consecutifs.get(source) ?? 0) + 1;
    this.consecutifs.set(source, consecutifs);

    const maintenant = Date.now();
    if (!doitAlerter(consecutifs, this.derniereAlerte.get(source), maintenant)) return;
    this.derniereAlerte.set(source, maintenant);

    const message =
      `⚠️ **${source}** : ${consecutifs} échecs d'ingestion consécutifs.\n` +
      `Dernier motif : ${detail}\n` +
      `Source probablement en panne (parser cassé, API modifiée). ` +
      `À vérifier sur /admin.`;
    this.logger.error(`Alerte ${source} : ${consecutifs} échecs consécutifs`);
    await this.envoyer(message);
  }

  private async envoyer(contenu: string): Promise<void> {
    const url = this.config.get<string>('DISCORD_ALERT_WEBHOOK_URL');
    if (!url) return;
    try {
      const reponse = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: contenu }),
      });
      if (!reponse.ok) {
        this.logger.warn(`Webhook Discord → ${reponse.status}`);
      }
    } catch (error) {
      // Une alerte qui échoue ne doit jamais faire tomber l'ingestion.
      this.logger.warn(`Webhook Discord injoignable : ${String(error)}`);
    }
  }
}
