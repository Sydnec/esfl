'use client';

import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import type { MatchSummary, TeamRef } from '@/lib/types';
import { Avatar } from './Avatar';
import styles from './BracketDiagram.module.css';

const CARD_H = 72; // carte : entête heure + 2 lignes d'équipe (≈ hauteur réelle)
const SLOT_H = 92; // hauteur réservée par match du 1er tour (carte + espace)
const COL_W = 200;

/** Tour d'un match : rank 0 = finale (droite), rank plus grand = tour plus tôt (gauche). */
const ROUND_RANKS: Array<{ re: RegExp; rank: number; label: string }> = [
  { re: /grand ?final|grande finale|(^|:)\s*final|\bfinale?\b/i, rank: 0, label: 'Finale' },
  { re: /semi.?final|demi.?finale/i, rank: 1, label: 'Demi-finales' },
  { re: /quarter.?final|quart/i, rank: 2, label: 'Quarts' },
  { re: /round of 16|huiti|1\/8/i, rank: 3, label: '8es' },
  { re: /round of 32|1\/16/i, rank: 4, label: '16es' },
];

function roundOf(name: string): { rank: number; index: number } | null {
  const found = ROUND_RANKS.find((r) => r.re.test(name));
  if (!found) return null;
  // Numéro du match dans le tour : celui avant le « : » (évite les chiffres
  // des noms d'équipe, ex. « Grand final: 9z vs G2 »).
  const num = name.split(':')[0].match(/(\d+)/);
  return { rank: found.rank, index: num ? parseInt(num[1], 10) : 1 };
}

function labelForRank(rank: number): string {
  return ROUND_RANKS.find((r) => r.rank === rank)?.label ?? '';
}

function tag(team: TeamRef | null): string {
  return team?.acronym || team?.name || 'TBD';
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
        {rest.length > 0 && <SubBracket matches={rest} />}
      </div>
    );
  }
  return <SubBracket matches={matches} />;
}

interface Placed extends MatchSummary {
  rank: number;
  index: number;
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

  // Centres verticaux : 1er tour réparti, puis chaque match centré sur ses 2 enfants.
  const cy = new Map<string, number>();
  const key = (rank: number, index: number) => `${rank}-${index}`;
  firstColumn.forEach((m, j) => cy.set(key(maxRank, m.index), (j + 0.5) * SLOT_H));
  for (let c = 1; c < ranks.length; c += 1) {
    const rank = ranks[c];
    const childRank = ranks[c - 1];
    byRank.get(rank)!.forEach((m, j) => {
      const c1 = cy.get(key(childRank, m.index * 2 - 1));
      const c2 = cy.get(key(childRank, m.index * 2));
      const centers = [c1, c2].filter((v): v is number => v != null);
      cy.set(
        key(rank, m.index),
        centers.length ? centers.reduce((a, b) => a + b, 0) / centers.length : (j + 0.5) * SLOT_H,
      );
    });
  }

  const cardW = COL_W - 30;
  const placed: Placed[] = [];
  ranks.forEach((rank, col) => {
    for (const m of byRank.get(rank)!) {
      placed.push({ ...m, rank, cx: col * COL_W + cardW / 2, cy: cy.get(key(rank, m.index)) ?? 0 });
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
                const parentIndex = Math.ceil(m.index / 2);
                const from = cy.get(key(rank, m.index));
                const to = cy.get(key(ranks[col + 1], parentIndex));
                if (from == null || to == null) return null;
                const x1 = col * COL_W + cardW;
                const x2 = (col + 1) * COL_W;
                const xm = (x1 + x2) / 2;
                return (
                  <path key={m.id} d={`M ${x1} ${from} H ${xm} V ${to} H ${x2}`} className={styles.line} />
                );
              }),
            )}
          </svg>
          {ranks.map((rank, col) => (
            <span key={`h-${rank}`} className={styles.roundLabel} style={{ left: col * COL_W, width: cardW }}>
              {labelForRank(rank)}
            </span>
          ))}
          {placed.map((m) => {
            const winnerSide =
              m.winnerTeamId === m.teamA?.id ? 'A' : m.winnerTeamId === m.teamB?.id ? 'B' : null;
            const live = m.status === 'running';
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
                <BracketRow team={m.teamA} score={m.scoreA} won={winnerSide === 'A'} />
                <BracketRow team={m.teamB} score={m.scoreB} won={winnerSide === 'B'} />
              </Link>
            );
          })}
        </div>
      </div>
      {extras.length > 0 && <BracketList matches={extras} />}
    </div>
  );
}

function BracketRow({ team, score, won }: { team: TeamRef | null; score: number | null; won: boolean }) {
  return (
    <span className={`${styles.row} ${won ? styles.won : ''}`}>
      <span className={styles.teamInfo}>
        {team && <Avatar src={team.imageUrl} label={team.name} size={16} />}
        <span className={styles.tag} title={team?.name}>
          {tag(team)}
        </span>
      </span>
      <span className={styles.score}>{score ?? '-'}</span>
    </span>
  );
}

/** Repli : matchs sans tour reconnu (deciders divers) → simple liste. */
function BracketList({ matches }: { matches: MatchSummary[] }) {
  return (
    <ul className={styles.extras}>
      {matches.map((m) => (
        <li key={m.id}>
          <Link href={`/matches/${m.id}`} className={styles.extraLink}>
            {m.name} · {m.scoreA ?? 0} : {m.scoreB ?? 0}
          </Link>
        </li>
      ))}
    </ul>
  );
}
