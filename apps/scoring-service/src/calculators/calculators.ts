import { GameId } from '@esfl/contracts';

/**
 * Scoring v4 — notes ABSOLUES façon HLTV / VLR (remplace le Z-score v3).
 *
 * Chaque jeu a un « Rating de base » calculé par une formule pondérée fixe,
 * converti sur 0-100, puis ajusté par des bonus/malus contextuels (comparaisons
 * intra-match, rôles). Repères : ~70 solide, ~85 MVP, 95+ exceptionnel. Validé
 * sur la population réelle (Valorant médiane 69, CS2 recalibré médiane 70).
 *
 * Contraintes de données assumées :
 * - CS2 (bo3.gg) : formule HLTV fidèle (KPR/DPR/ADR/KAST), toutes les entrées
 *   publiées par la source.
 * - Valorant : formule VLR complète. Bonus FK/FD du match et clutchs (sans
 *   rôle).
 * - LoL : KDA/KP/GPM/VSM. Bonus par rôle (Support, Jungler approximé). Le bonus
 *   Toplaner (dégâts tourelles) n'est pas implémenté (donnée absente).
 */
export const SCORING_VERSION = 'v4';

/** Sous-ensemble du match nécessaire au comptage des maps/rounds. */
export interface MatchMapsInfo {
  gamesSummary?: Array<{
    position: number;
    winner: 'A' | 'B' | null;
    scoreA?: number | null;
    scoreB?: number | null;
  }> | null;
  scoreA?: number | null;
  scoreB?: number | null;
}

/** Nombre de maps décidées (repli scoreA+scoreB, sinon 1). */
export function mapsPlayed(match: MatchMapsInfo): number {
  const decided = (match.gamesSummary ?? []).filter((game) => game.winner != null).length;
  if (decided > 0) return decided;
  const fromScore = (match.scoreA ?? 0) + (match.scoreB ?? 0);
  return fromScore > 0 ? fromScore : 1;
}

/**
 * Total de rounds joués (CS2/Valorant) = Σ (scoreA + scoreB) des maps. Base des
 * métriques par round (KPR/DPR/APR). 0 si aucun score de map n'est disponible.
 */
export function roundsPlayed(match: MatchMapsInfo): number {
  return (match.gamesSummary ?? []).reduce(
    (sum, game) => sum + (game.scoreA ?? 0) + (game.scoreB ?? 0),
    0,
  );
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Vrai si la métrique est réellement publiée (nombre fini), pas juste 0/absente. */
function has(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value);
}

/** Valeur si publiée, sinon une valeur neutre (imputation d'un trou de source). */
function numOr(source: Record<string, unknown>, key: string, fallback: number): number {
  return has(source, key) ? (source[key] as number) : fallback;
}

// Valeurs neutres d'imputation (médianes population), pour ne pas pénaliser un
// trou de données de la source (VLR muet sur KAST/ADR sur certains matchs).
const VALO_KAST_NEUTRE = 71;
const VALO_ADR_NEUTRE = 129;
/** Un KDA extrême (0-1 mort) ne doit pas exploser la note : plafond. */
const LOL_KDA_MAX = 10;

/** Rôle LoL canonique (clé des bonus de rôle). */
export function canonicalLolRole(role: string | null | undefined): string {
  const r = (role ?? '').toLowerCase();
  if (/top/.test(r)) return 'TOP';
  if (/jun|jgl|jng/.test(r)) return 'JUN';
  if (/mid|middle/.test(r)) return 'MID';
  if (/bot|adc|carry/.test(r)) return 'ADC';
  if (/sup/.test(r)) return 'SUP';
  return 'Autre';
}

// ─── Conversion Rating → Note (ÉDITABLE) ────────────────────────────────────

/**
 * Dispersion de référence des ratings, commune aux trois jeux. C'est le σ
 * naturel du rating VLR mesuré sur la population réelle (0,202).
 */
export const SIGMA_REF = 0.2;

/**
 * Médiane et dispersion du rating BRUT de chaque jeu, mesurées sur la base.
 *
 * Les ratings ne sont PAS comparables tels quels : le rating HLTV s'étale
 * presque deux fois plus que le rating VLR (σ 0,357 contre 0,202). Une pente
 * unique donnerait 73 à une perf de top-décile CS2 contre 63 à son équivalent
 * Valorant, et picker CS2 deviendrait mécaniquement avantageux. On recentre
 * donc chaque jeu sur 1,00 et on le ramène à `SIGMA_REF` avant de convertir.
 *
 * À repasser après tout changement de formule ou de source de stats : la
 * requête de mesure est dans docs/scoring-et-donnees.md.
 */
export const CALIBRAGE_JEU: Record<GameId, { mediane: number; sigma: number }> = {
  cs2: { mediane: 1.072, sigma: 0.357 },
  valorant: { mediane: 0.991, sigma: 0.202 },
  lol: { mediane: 0.942, sigma: 0.247 },
};

/**
 * Rating brut → note sur 100. Le rating est d'abord ramené sur l'échelle
 * commune, puis converti à raison de 50 points par point de rating : une perf
 * médiane vaut 50, un rating calibré de 2,00 (soit +5σ, exceptionnel) vaut 100,
 * une vraie sous-performance tombe à 0.
 */
export function noteDepuisRating(gameId: GameId, ratingBrut: number): number {
  const { mediane, sigma } = CALIBRAGE_JEU[gameId];
  const calibre = sigma > 0 ? 1 + (ratingBrut - mediane) * (SIGMA_REF / sigma) : ratingBrut;
  return clamp(calibre * 50, 0, 100);
}

// ─── Formules de Rating de base (ÉDITABLES) ─────────────────────────────────
// Chacune renvoie un RATING brut, centré sur ~1 dans son propre jeu ; la
// conversion en note est centralisée dans `noteDepuisRating`.

/**
 * CS2, HLTV 2.0 fidèle : toutes les entrées sont publiées par bo3 (stats par
 * map). Le terme d'Impact — surpondération des kills et des assists, qui
 * distingue le joueur décisif du joueur qui accumule en fin de round — était
 * auparavant absorbé dans la constante, faute d'assists exploitables. Sans lui
 * le rating tournait autour de 0,75 au lieu de 1,0 et la population était
 * tassée (médiane 60 au lieu de 70).
 */
export function cs2Rating(i: {
  kpr: number;
  dpr: number;
  apr: number;
  adr: number;
  kast: number;
}): number {
  const impact = 2.13 * i.kpr + 0.42 * i.apr - 0.41;
  return (
    0.0073 * i.kast +
    0.3591 * i.kpr -
    0.5329 * i.dpr +
    0.2372 * impact +
    0.0032 * i.adr +
    0.1587
  );
}
/**
 * KAST de repli : seules les ingestions antérieures à la bascule vers les stats
 * par map en sont dépourvues. Valeur neutre, pour ne pas pénaliser une fiche
 * incomplète.
 */
export const CS2_KAST_DEFAUT = 70;

/** Valorant (VLR 2.0, fidèle). */
export function valorantRating(i: {
  kpr: number;
  apr: number;
  dpr: number;
  adr: number;
  kast: number;
}): number {
  return i.kpr * 0.55 + i.apr * 0.23 + i.adr * 0.0025 + i.kast * 0.0031 - i.dpr * 0.87 + 0.61;
}

/** LoL (impact global, données complètes). KP % entier, GPM = or/min, VSM = vision/min. */
export function lolRating(i: { kda: number; kp: number; gpm: number; vsm: number }): number {
  return i.kda * 0.05 + i.kp * 0.005 + i.gpm * 0.001 + i.vsm * 0.1 + 0.15;
}

/**
 * LoL de SECOURS quand GPM (et souvent VSM) manquent : Leaguepedia n'a le détail
 * complet que pour les ligues majeures (bots Riot) ; les ligues mineures sont
 * saisies à la main, souvent limitées au KDA/KP. On surpondère alors ce qui est
 * toujours présent (KDA plafonné + Kill Participation).
 */
export function lolFallbackRating(i: { kda: number; kp: number }): number {
  return i.kda * 0.06 + i.kp * 0.008 + 0.2;
}
// ────────────────────────────────────────────────────────────────────────────

/** Ligne de stats d'un joueur pour la notation d'un match. */
export interface PlayerStatLine {
  playerId: string;
  gameId: GameId;
  normalized: unknown;
  role: string | null;
  teamSide: 'A' | 'B' | null;
}

/** Contexte match : rounds (CS2/Valo) et objectifs neutres par côté (LoL). */
export interface MatchScoringContext {
  rounds: number;
  teamObjectives?: { A: number; B: number } | null;
}

export interface PlayerScore {
  playerId: string;
  points: number;
  breakdown: Record<string, number>;
}

/**
 * Note un match entier en deux passes : rating de base par joueur, puis bonus
 * contextuels (comparaisons intra-match, rôles), plafonné à [0, 100]. Prend tout
 * le roster pour les bonus relatifs (max FK/FD du match). Fonction pure.
 */
export function scoreMatch(players: PlayerStatLine[], ctx: MatchScoringContext): PlayerScore[] {
  // Passe 1 : rating de base + métriques dérivées (pour le breakdown).
  const bases = players.map((player) => base(player, ctx));

  // Contexte match pour les bonus relatifs Valorant.
  const maxFk = Math.max(0, ...bases.map((b) => b.derived.firstKills ?? 0));
  const maxFd = Math.max(0, ...bases.map((b) => b.derived.firstDeaths ?? 0));

  return bases.map((b) => {
    const note = noteDepuisRating(b.player.gameId, b.rating);
    const bonus = contextualBonus(b, ctx, maxFk, maxFd);
    // Points fantasy entiers ; le breakdown garde le détail décimal.
    const points = Math.round(clamp(note + bonus.total, 0, 100));
    return {
      playerId: b.player.playerId,
      points,
      breakdown: {
        ...Object.fromEntries(Object.entries(b.derived).map(([k, v]) => [k, round2(v)])),
        rating: round2(b.rating),
        base: round2(note),
        ...bonus.detail,
        bonus: round2(bonus.total),
      },
    };
  });
}

interface BaseResult {
  player: PlayerStatLine;
  /** Rating BRUT du jeu, avant mise à l'échelle commune. */
  rating: number;
  derived: Record<string, number>;
}

/** Rating de base d'un joueur + métriques dérivées, selon le jeu. */
function base(player: PlayerStatLine, ctx: MatchScoringContext): BaseResult {
  const n = (player.normalized ?? {}) as Record<string, unknown>;
  const rounds = Math.max(1, ctx.rounds);

  if (player.gameId === 'cs2') {
    const derived = {
      kpr: num(n, 'kills') / rounds,
      dpr: num(n, 'deaths') / rounds,
      apr: num(n, 'assists') / rounds,
      adr: num(n, 'adr'),
      kast: numOr(n, 'kast', CS2_KAST_DEFAUT),
      firstKills: num(n, 'firstKills'),
      clutches: num(n, 'clutches'),
    };
    return { player, rating: cs2Rating(derived), derived };
  }

  if (player.gameId === 'valorant') {
    const derived = {
      kpr: num(n, 'kills') / rounds,
      apr: num(n, 'assists') / rounds,
      dpr: num(n, 'deaths') / rounds,
      // KAST/ADR imputés à la médiane si la source ne les publie pas.
      adr: numOr(n, 'adr', VALO_ADR_NEUTRE),
      kast: numOr(n, 'kast', VALO_KAST_NEUTRE),
      // Conservés pour les bonus (pas dans le rating de base VLR).
      firstKills: num(n, 'firstKills'),
      firstDeaths: num(n, 'firstDeaths'),
      clutches: num(n, 'clutches'),
    };
    return { player, rating: valorantRating(derived), derived };
  }

  // LoL : formule complète si GPM publié, sinon secours KDA/KP (ligues mineures).
  const deaths = num(n, 'deaths');
  const kda = Math.min(LOL_KDA_MAX, (num(n, 'kills') + num(n, 'assists')) / Math.max(1, deaths));
  // killParticipation stocké en fraction (0-1) → pourcentage entier attendu.
  const kp = num(n, 'killParticipation') * 100;
  const gpm = num(n, 'goldPerMin');
  const vsm = num(n, 'visionPerMin');
  const controlWards = num(n, 'controlWards');
  if (has(n, 'goldPerMin') && gpm > 0) {
    const derived = { kda, kp, gpm, vsm, controlWards };
    return { player, rating: lolRating(derived), derived };
  }
  const derived = { kda, kp, controlWards, fallback: 1 };
  return { player, rating: lolFallbackRating({ kda, kp }), derived };
}

interface BonusResult {
  total: number;
  detail: Record<string, number>;
}

/** Bonus/malus contextuels selon le jeu. */
function contextualBonus(
  b: BaseResult,
  ctx: MatchScoringContext,
  maxFk: number,
  maxFd: number,
): BonusResult {
  const detail: Record<string, number> = {};
  let total = 0;

  if (b.player.gameId === 'valorant') {
    // +3 au(x) meilleur(s) First Kill du match, −3 au(x) pire(s) First Death.
    if (maxFk > 0 && (b.derived.firstKills ?? 0) === maxFk) {
      detail.bonusFk = 3;
      total += 3;
    }
    if (maxFd > 0 && (b.derived.firstDeaths ?? 0) === maxFd) {
      detail.bonusFd = -3;
      total -= 3;
    }
    // +2 à tout joueur ayant remporté plus de 2 clutchs (sans rôle).
    if ((b.derived.clutches ?? 0) > 2) {
      detail.bonusClutch = 2;
      total += 2;
    }
  } else if (b.player.gameId === 'lol') {
    const role = canonicalLolRole(b.player.role);
    if (role === 'SUP') {
      detail.bonusSupport = 8;
      total += 8;
      if ((b.derived.controlWards ?? 0) > 3) {
        detail.bonusWards = 2;
        total += 2;
      }
    } else if (role === 'JUN' && ctx.teamObjectives && b.player.teamSide) {
      // Approximation : objectifs neutres de l'équipe attribués au jungler.
      const objectives = ctx.teamObjectives[b.player.teamSide] ?? 0;
      if (objectives > 0) {
        detail.bonusObjectives = objectives * 2;
        total += objectives * 2;
      }
    }
  }

  return { total, detail };
}
