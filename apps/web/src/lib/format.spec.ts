import { describe, expect, it } from 'vitest';
import { pointsDefinitifs } from './format';

describe('pointsDefinitifs', () => {
  it('n’ouvre les points fantasy qu’une fois le match terminé', () => {
    expect(pointsDefinitifs('finished')).toBe(true);
    expect(pointsDefinitifs('running')).toBe(false);
    expect(pointsDefinitifs('not_started')).toBe(false);
    expect(pointsDefinitifs('canceled')).toBe(false);
  });
});
