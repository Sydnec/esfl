/** Code pays ISO2 → drapeau emoji (indicateurs régionaux). Chaîne vide si inconnu. */
export function flagEmoji(iso: string | null | undefined): string {
  if (!iso || !/^[a-zA-Z]{2}$/.test(iso)) return '';
  const code = iso.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + code.charCodeAt(0) - 65,
    0x1f1e6 + code.charCodeAt(1) - 65,
  );
}
