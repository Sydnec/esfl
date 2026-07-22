'use client';

import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import type { MatchSummary, TeamRef } from '@/lib/types';
import { Avatar } from './Avatar';
import styles from './BracketDiagram.module.css';

const CARD_H = 72; // carte : entête heure + 2 lignes d'équipe (≈ hauteur réelle)
const SLOT_H = 92; // hauteur réservée par match du 1er tour (carte + espace)
const COL_W = 160;

/** Tour d'un match : rank 0 = finale (droite), rank plus grand = tour plus tôt (gauche). */
const ROUND_RANKS: Array<{ re: RegExp; rank: number; label: string }> = [
  { re: /grand ?final|grande finale|(^|:)\s*final|\bfinale?\b/i, rank: 0, label: 'Finale' },
  { re: /semi.?final|demi.?finale/i, rank: 1, label: 'Demi-finales' },
  { re: /quarter.?final|quart/i, rank: 2, label: 'Quarts' },
  { re: /round of 16|huiti|1\/8/i, rank: 3, label: '8es' },
  { re: /round of 32|1\/16/i, rank: 4, label: '16es' },
];

/** Rang de base des tours « round N » du lower bracket, au-dessus des tours
 *  nommés (quarts = 2) : round 1 le plus à gauche, rang décroissant avec N. */
const LOWER_ROUND_BASE = 20;

export function roundOf(name: string): { rank: number; index: number } | null {
  // Le « : » borne la recherche pour ignorer les chiffres des noms d'équipe
  // (« Grand final: 9z vs G2 »).
  const label = name.split(':')[0];
  // Lower bracket « round N » : tours mineurs sans nom, joués avant les quarts.
  // « round 1 » n'est pas « round of 16 » et échappait à ROUND_RANKS ; ces
  // matchs finissaient alors en liste au lieu de cartes dans l'arbre.
  const lower = label.match(/round\s+(\d+)/i);
  if (lower && !/round\s+of/i.test(label)) {
    const n = parseInt(lower[1], 10);
    const num = label.replace(/round\s+\d+/i, ' ').match(/(\d+)/);
    return { rank: LOWER_ROUND_BASE - n, index: num ? parseInt(num[1], 10) : 1 };
  }
  const found = ROUND_RANKS.find((r) => r.re.test(name));
  if (!found) return null;
  // Numéro du match DANS le tour. On retire d'abord le libellé du tour : sinon
  // « Round of 32 match 10 » rendait 32, le premier nombre rencontré, si bien
  // que les seize matchs du tour partageaient le même index et se superposaient.
  const num = label.replace(found.re, ' ').match(/(\d+)/);
  return { rank: found.rank, index: num ? parseInt(num[1], 10) : 1 };
}

function labelForRank(rank: number): string {
  const named = ROUND_RANKS.find((r) => r.rank === rank);
  if (named) return named.label;
  // Tours « round N » du lower bracket (rangs LOWER_ROUND_BASE - N).
  if (rank >= ROUND_RANKS.length) return `Tour ${LOWER_ROUND_BASE - rank}`;
  return '';
}

function tag(team: TeamRef | null): string {
  return team?.acronym || team?.name || 'TBD';
}

/**
 * Ce qu'on affiche dans un créneau encore vide, à partir du match qui l'alimente.
 *
 * « TBD » n'apprend rien alors que l'arbre sait déjà d'où viendra l'équipe : le
 * connecteur est tracé depuis ce match précis. On verbalise donc une relation
 * DÉJÀ affichée, sans rien affirmer de neuf. Le détail part en `title`, faute
 * de place dans une carte de 130 px.
 */
export function creneauAPourvoir(alimentateur: MatchSummary | null): {
  texte: string;
  detail?: string;
} {
  if (!alimentateur) return { texte: 'TBD' };
  const a = tag(alimentateur.teamA);
  const b = tag(alimentateur.teamB);
  const vainqueur =
    alimentateur.status === 'finished'
      ? [alimentateur.teamA, alimentateur.teamB].find(
          (equipe) => equipe && equipe.id === alimentateur.winnerTeamId,
        )
      : null;
  // Match joué : l'équipe qualifiée est connue, même si la source n'a pas
  // encore rempli le tour suivant.
  if (vainqueur) return { texte: tag(vainqueur), detail: `Qualifié : ${vainqueur.name}` };
  // Match déjà joué mais sans vainqueur connu (forfait, annulation, données
  // incomplètes) : annoncer « A ou B » laisserait croire l'issue en suspens.
  const joue = alimentateur.status === 'finished' || alimentateur.status === 'canceled';
  // Les deux adversaires sont connus mais pas encore départagés.
  if (!joue && alimentateur.teamA && alimentateur.teamB) {
    return { texte: `${a} ou ${b}`, detail: `Vainqueur de ${alimentateur.name}` };
  }
  return { texte: 'TBD' };
}

/**
 * Arbre par phase : gère la double élimination (GSL) en séparant upper / lower
 * bracket en deux sous-arbres. Chaque sous-arbre est un arbre à élimination
 * simple (colonnes par tour + connecteurs i → ceil(i/2)).
 */
export function BracketDiagram({ matches }: { matches: MatchSummary[] }) {
  const upper: MatchSummary[] = [];
  const lower: MatchSummary[] = [];
  const rest: MatchSummary[] = [];
  for (const match of matches) {
    const lower_name = match.name.toLowerCase();
    if (/\bupper\b/.test(lower_name)) upper.push(match);
    else if (/\blower\b/.test(lower_name)) lower.push(match);
    else rest.push(match);
  }

  if (upper.length > 0 || lower.length > 0) {
    return (
      <div className={styles.doubleElim}>
        {upper.length > 0 && <SubBracket matches={upper} label="Upper bracket" />}
        {lower.length > 0 && <SubBracket matches={lower} label="Lower bracket" />}
        {rest.length > 0 && <SubBracket matches={rest} label="Grande finale" />}
      </div>
    );
  }
  return <SubBracket matches={matches} />;
}

interface Placed extends MatchSummary {
  rank: number;
  index: number;
  /** Colonne dans le sous-arbre : sert à retrouver la colonne alimentante. */
  col: number;
  cx: number;
  cy: number;
}

/** Sous-arbre à élimination simple : colonnes par tour, connecteurs SVG. */
function SubBracket({ matches, label }: { matches: MatchSummary[]; label?: string }) {
  const byRank = new Map<number, Array<MatchSummary & { index: number }>>();
  const extras: MatchSummary[] = [];
  for (const match of matches) {
    const r = roundOf(match.name);
    if (!r) {
      extras.push(match);
      continue;
    }
    const list = byRank.get(r.rank) ?? [];
    list.push({ ...match, index: r.index });
    byRank.set(r.rank, list);
  }
  for (const list of byRank.values()) list.sort((a, b) => a.index - b.index);

  const ranks = [...byRank.keys()].sort((a, b) => b - a); // gauche→droite : tour le plus tôt d'abord
  if (ranks.length === 0) {
    return (
      <div>
        {label && <span className={styles.subLabel}>{label}</span>}
        <BracketList matches={matches} />
      </div>
    );
  }

  const maxRank = ranks[0];
  const firstColumn = byRank.get(maxRank)!;
  const height = Math.max(1, firstColumn.length) * SLOT_H;

  // Alimentation d'un tour par le précédent : ratio 2 en simple élimination
  // (deux matchs → un), 1 sur un tour mineur du lower bracket qui garde le même
  // nombre de matchs (round N → quarts). Déduit du rapport des effectifs.
  const count = (rank: number) => byRank.get(rank)?.length ?? 0;
  const ratio = (childRank: number, parentRank: number) =>
    Math.max(1, Math.round(count(childRank) / Math.max(1, count(parentRank))));
  const feederIndexes = (index: number, r: number) =>
    Array.from({ length: r }, (_, k) => (index - 1) * r + 1 + k);

  // Centres verticaux : 1er tour réparti, puis chaque match centré sur ses enfants.
  const cy = new Map<string, number>();
  const key = (rank: number, index: number) => `${rank}-${index}`;
  firstColumn.forEach((m, j) => cy.set(key(maxRank, m.index), (j + 0.5) * SLOT_H));
  for (let c = 1; c < ranks.length; c += 1) {
    const rank = ranks[c];
    const childRank = ranks[c - 1];
    const r = ratio(childRank, rank);
    byRank.get(rank)!.forEach((m, j) => {
      const centers = feederIndexes(m.index, r)
        .map((k) => cy.get(key(childRank, k)))
        .filter((v): v is number => v != null);
      cy.set(
        key(rank, m.index),
        centers.length ? centers.reduce((a, b) => a + b, 0) / centers.length : (j + 0.5) * SLOT_H,
      );
    });
  }

  // Enfants d'une carte : mêmes indices que les connecteurs déjà tracés
  // (i → 2i-1 et 2i, dans la colonne de gauche). On ne prétend donc rien de
  // plus que ce que l'arbre affiche.
  const parIndex = new Map<string, MatchSummary>();
  for (const [rank, liste] of byRank) {
    for (const m of liste) parIndex.set(`${rank}-${m.index}`, m);
  }
  const alimentateurs = (rank: number, index: number, col: number) => {
    const childRank = ranks[col - 1];
    if (childRank === undefined) return { a: null, b: null };
    const [i1, i2] = feederIndexes(index, ratio(childRank, rank));
    return {
      a: parIndex.get(`${childRank}-${i1}`) ?? null,
      b: i2 != null ? (parIndex.get(`${childRank}-${i2}`) ?? null) : null,
    };
  };

  const cardW = COL_W - 30;
  const placed: Placed[] = [];
  ranks.forEach((rank, col) => {
    for (const m of byRank.get(rank)!) {
      placed.push({
        ...m,
        rank,
        col,
        cx: col * COL_W + cardW / 2,
        cy: cy.get(key(rank, m.index)) ?? 0,
      });
    }
  });
  const width = ranks.length * COL_W;

  return (
    <div>
      {label && <span className={styles.subLabel}>{label}</span>}
      <div className={styles.wrapper}>
        <div className={styles.bracket} style={{ width, height }}>
          <svg className={styles.lines} width={width} height={height} aria-hidden>
            {ranks.slice(0, -1).map((rank, col) =>
              byRank.get(rank)!.map((m) => {
                const parentRank = ranks[col + 1];
                const parentIndex = Math.ceil(m.index / ratio(rank, parentRank));
                const from = cy.get(key(rank, m.index));
                const to = cy.get(key(parentRank, parentIndex));
                if (from == null || to == null) return null;
                const x1 = col * COL_W + cardW;
                const x2 = (col + 1) * COL_W;
                const xm = (x1 + x2) / 2;
                return (
                  <path
                    key={m.id}
                    d={`M ${x1} ${from} H ${xm} V ${to} H ${x2}`}
                    className={styles.line}
                  />
                );
              }),
            )}
          </svg>
          {ranks.map((rank, col) => (
            <span
              key={`h-${rank}`}
              className={styles.roundLabel}
              style={{ left: col * COL_W, width: cardW }}
            >
              {labelForRank(rank)}
            </span>
          ))}
          {placed.map((m) => {
            const winnerSide =
              m.winnerTeamId === m.teamA?.id ? 'A' : m.winnerTeamId === m.teamB?.id ? 'B' : null;
            const live = m.status === 'running';
            // Avant le coup d'envoi : pas de score (0-0 trompeur). Une fois lancé
            // (running/finished), on affiche les scores, 0 compris.
            const started = live || m.status === 'finished';
            // Calculé une fois pour les deux créneaux de la carte.
            const feeders = alimentateurs(m.rank, m.index, m.col);
            return (
              <Link
                key={m.id}
                href={`/matches/${m.id}`}
                className={styles.card}
                style={{ left: m.cx - cardW / 2, top: m.cy - CARD_H / 2, width: cardW }}
              >
                {(m.scheduledAt || live) && (
                  <span className={styles.cardTime}>
                    <span className={styles.cardTimeText}>
                      {m.scheduledAt ? formatDateTime(m.scheduledAt) : ''}
                    </span>
                    {live &&
                      (m.streamUrl ? (
                        <span
                          className={styles.live}
                          role="link"
                          tabIndex={0}
                          title="Voir le live"
                          onClick={(event) => {
                            // Carte = lien vers le match ; on ne suit que le stream.
                            event.preventDefault();
                            event.stopPropagation();
                            window.open(m.streamUrl as string, '_blank', 'noopener');
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.stopPropagation();
                              window.open(m.streamUrl as string, '_blank', 'noopener');
                            }
                          }}
                        >
                          live
                        </span>
                      ) : (
                        <span className={styles.liveStatic}>live</span>
                      ))}
                  </span>
                )}
                <BracketRow
                  team={m.teamA}
                  score={m.scoreA}
                  won={winnerSide === 'A'}
                  started={started}
                  alimentateur={feeders.a}
                />
                <BracketRow
                  team={m.teamB}
                  score={m.scoreB}
                  won={winnerSide === 'B'}
                  started={started}
                  alimentateur={feeders.b}
                />
              </Link>
            );
          })}
        </div>
      </div>
      {extras.length > 0 && <BracketList matches={extras} />}
    </div>
  );
}

function BracketRow({
  team,
  score,
  won,
  started,
  alimentateur,
}: {
  team: TeamRef | null;
  score: number | null;
  won: boolean;
  started: boolean;
  /** Match dont sort l'équipe attendue, quand le créneau est encore vide. */
  alimentateur?: MatchSummary | null;
}) {
  const attente = team ? null : creneauAPourvoir(alimentateur ?? null);
  return (
    <span className={`${styles.row} ${won ? styles.won : ''}`}>
      <span className={styles.teamInfo}>
        {team && <Avatar src={team.imageUrl} label={team.name} size={16} />}
        <span
          className={`${styles.tag} ${attente && attente.detail ? styles.attente : ''}`}
          title={team?.name ?? attente?.detail}
        >
          {attente ? attente.texte : tag(team)}
        </span>
      </span>
      {/* Match pas commencé : rien (pas de 0 trompeur). Lancé : score, 0 compris. */}
      <span className={styles.score}>{started ? (score ?? 0) : ''}</span>
    </span>
  );
}

/** Repli : matchs sans tour reconnu (deciders divers) → simple liste. */
function BracketList({ matches }: { matches: MatchSummary[] }) {
  return (
    <ul className={styles.extras}>
      {matches.map((m) => {
        const started = m.status === 'running' || m.status === 'finished';
        return (
          <li key={m.id}>
            <Link href={`/matches/${m.id}`} className={styles.extraLink}>
              {m.name}
              {started ? ` · ${m.scoreA ?? 0} : ${m.scoreB ?? 0}` : ''}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
