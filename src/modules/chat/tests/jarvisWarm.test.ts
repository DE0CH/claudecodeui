import { describe, expect, it } from 'vitest';

import { createWarmThrottle } from '@/modules/chat/utils/jarvisWarm';

describe('createWarmThrottle', () => {
  it('sends at most once per interval per conversation, a new chat counting as one', () => {
    let t = 0;
    const sent: Array<string | null> = [];
    const warm = createWarmThrottle((id) => sent.push(id), 30_000, () => t);
    warm(null);
    warm(null);
    warm('a');
    warm('a');
    warm('b');
    expect(sent).toEqual([null, 'a', 'b']);
    t = 29_999;
    warm('a');
    warm(null);
    expect(sent).toEqual([null, 'a', 'b']);
    t = 30_000;
    warm('a');
    warm(null);
    expect(sent).toEqual([null, 'a', 'b', 'a', null]);
  });
});
