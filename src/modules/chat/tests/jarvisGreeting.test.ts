import { describe, expect, it } from 'vitest';

import { GREETINGS, greeting, greetingLocale, pool, slotAt } from '@/modules/chat/utils/jarvisGreeting';

// Hong Kong is UTC+8 all year
const at = (hkHour: number) => new Date(Date.UTC(2026, 9, 21, (hkHour - 8 + 24) % 24, 30));
const HOUR = { morning: 8, afternoon: 14, evening: 20, night: 1 } as const;
const SLOTS = ['morning', 'afternoon', 'evening', 'night'] as const;
const ZH_ANY = ['你好呀', '你好', '哈囉', '嗨', '喂，你好', '哈囉哈囉', '嘿', '你好嗎？', '點呀？', '近排點呀？', '一切順利嗎？', '最近過成點？', '有咩新嘢？', '而家發生緊咩事？'];
const EN_ANY = ['Good day', 'Hello', 'Hi', 'Hey', 'Hello there', 'Hiya', 'Hey there', 'How are you?', 'How are you doing?', "How's it going?", "How's everything?", "How's life?", "What's new?", "What's going on?"];

// The set Deyao approved on 2026-10-21 (DE0CH/jarvis3 3953d31), verbatim.
describe('jarvis greeting', () => {
  it('time slots by the Hong Kong hour, whatever the viewer\'s time zone', () => {
    expect([5, 11, 12, 17, 18, 22, 23, 2, 4].map((h) => slotAt(at(h)))).toEqual(
      ['morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night', 'night'],
    );
  });

  it("each slot's pool: its own phrases, the any-time ones, the daytime one in the morning and afternoon", () => {
    const DAY_ZH = ['今日打得掂嗎？'], DAY_EN = ['How goes the battle?'];
    expect(pool('zh-HK', 'morning')).toEqual(['早晨', '早呀', '早晨！今日精神嗎？', ...ZH_ANY, ...DAY_ZH]);
    expect(pool('zh-HK', 'afternoon')).toEqual(['下晝好', '食咗飯未呀？', ...ZH_ANY, ...DAY_ZH]);
    expect(pool('zh-HK', 'evening')).toEqual(['夜晚好', '食咗飯未呀？', ...ZH_ANY]);
    expect(pool('zh-HK', 'night')).toEqual(['夜喇，仲未瞓？', '早唞', ...ZH_ANY]);
    expect(pool('en', 'morning')).toEqual(['Good morning', 'Morning', 'Top of the morning', ...EN_ANY, ...DAY_EN]);
    expect(pool('en', 'afternoon')).toEqual(['Good afternoon', "How's it going?", ...EN_ANY, ...DAY_EN]);
    expect(pool('en', 'evening')).toEqual(['Good evening', "How's everything?", ...EN_ANY]);
    expect(pool('en', 'night')).toEqual(['Hello again', 'Hi there', ...EN_ANY]);
    for (const slot of SLOTS) {
      expect(pool('en', slot, true).length).toBe(pool('zh-HK', slot, true).length);
      for (const loc of ['zh-HK', 'en'] as const) {
        const list = pool(loc, slot);
        const seen = new Set<string>();
        for (let i = 0; i < list.length; i++) seen.add(greeting(loc, at(HOUR[slot]), i / list.length));
        expect([...seen].sort()).toEqual([...new Set(list)].sort());
        expect(greeting(loc, at(HOUR[slot]), 0.999999)).toBe(list.at(-1));
      }
    }
  });

  it('returning users only: 又見面喇 / 歡迎返嚟 (Hello again / Welcome)', () => {
    for (const slot of SLOTS) {
      expect(pool('zh-HK', slot)).not.toContain('歡迎返嚟');
      expect(pool('zh-HK', slot, true)).toEqual([...pool('zh-HK', slot), '又見面喇', '歡迎返嚟']);
      expect(pool('en', slot, true)).toEqual([...pool('en', slot), 'Hello again', 'Welcome']);
      expect(greeting('zh-HK', at(HOUR[slot]), 0.999999, null, true)).toBe('歡迎返嚟');
      expect(greeting('zh-HK', at(HOUR[slot]), 0.999999, null, false)).not.toBe('歡迎返嚟');
    }
    expect(greeting('en', at(20), 0.999999, 'Deyao', true)).toBe('Welcome, Deyao');
  });

  it('the name: after a comma, before a closing question mark', () => {
    const idx = (loc: 'zh-HK' | 'en', slot: keyof typeof HOUR, phrase: string) => {
      const list = pool(loc, slot);
      return (list.indexOf(phrase) + 0.5) / list.length;
    };
    expect(greeting('zh-HK', at(8), 0)).toBe('早晨');
    expect(greeting('en', at(8), 0, 'Deyao')).toBe('Good morning, Deyao');
    expect(greeting('zh-HK', at(8), 0, 'Deyao')).toBe('早晨，Deyao');
    expect(greeting('en', at(8), 0, '  ')).toBe('Good morning');
    expect(greeting('zh-HK', at(14), idx('zh-HK', 'afternoon', '點呀？'), 'Tai Man')).toBe('點呀，Tai Man？');
    expect(greeting('zh-HK', at(8), idx('zh-HK', 'morning', '早晨！今日精神嗎？'), 'Tai Man')).toBe('早晨！今日精神嗎，Tai Man？');
    expect(greeting('zh-HK', at(1), idx('zh-HK', 'night', '夜喇，仲未瞓？'), '陳大文')).toBe('夜喇，仲未瞓，陳大文？');
    expect(greeting('en', at(14), idx('en', 'afternoon', 'How goes the battle?'), 'Deyao')).toBe('How goes the battle, Deyao?');
  });

  it('the locale: any Chinese UI language greets in zh-HK, others in English', () => {
    expect(greetingLocale('zh-HK')).toBe('zh-HK');
    expect(greetingLocale('zh-TW')).toBe('zh-HK');
    expect(greetingLocale('en')).toBe('en');
    expect(greetingLocale(undefined)).toBe('en');
    expect(Object.keys(GREETINGS)).toEqual(['zh-HK', 'en']);
  });
});
