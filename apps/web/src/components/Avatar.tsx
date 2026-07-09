'use client';

import { useState } from 'react';
import styles from './Avatar.module.css';

interface AvatarProps {
  /** Image principale (ex : photo du joueur). */
  src: string | null | undefined;
  /** Repli (ex : logo de l'équipe) si la principale manque ou casse. */
  fallbackSrc?: string | null;
  /** Nom affiché en alt et pour les initiales du placeholder. */
  label: string;
  size?: number;
}

/** Avatar avec chaîne de replis : image → fallback → initiales. */
export function Avatar({ src, fallbackSrc, label, size = 32 }: AvatarProps) {
  const sources = [src, fallbackSrc].filter((value): value is string => Boolean(value));
  const [index, setIndex] = useState(0);
  const current = sources[index];

  if (!current) {
    return (
      <span
        className={styles.placeholder}
        style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
        aria-hidden
      >
        {label.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    // <img> volontaire : images distantes (CDN Pandascore), pas d'optimisation Next nécessaire.
    <img
      className={styles.image}
      src={current}
      alt={label}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setIndex((value) => value + 1)}
    />
  );
}
