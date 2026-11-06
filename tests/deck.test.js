/**
 * 牌组引擎单元测试。
 * 运行：npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeck,
  createRng,
  createShuffledDeck,
  deal,
  shuffle,
} from '../shared/deck.js';
import {
  CARD_TYPES,
  CARDS_PER_PLAYER,
  COLORS,
  DECK_SIZE,
} from '../shared/constants.js';

/** 统计数组里每个值出现的次数 */
function countBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

describe('牌组构成', () => {
  const deck = createDeck();

  it('总张数为 108', () => {
    assert.equal(deck.length, DECK_SIZE);
  });

  it('四种颜色各有 25 张（19 张数字牌 + 6 张功能牌）', () => {
    const perColor = countBy(deck, (card) => card.color);
    for (const color of COLORS) {
      assert.equal(perColor.get(color), 25, `${color} 应为 25 张`);
    }
    // null 代表万能牌，不算颜色
    assert.equal(
      [...perColor.keys()].filter((key) => key !== null).length,
      4,
      '不应出现四种以外的颜色',
    );
    // 校验拆分：25 = 19 + 6
    assert.equal(
      [...perColor.values()].reduce((sum, n) => sum + n, 0),
      108,
      '四色加万能牌合计应为 108 张',
    );
  });

  it('每色数字 0 只有 1 张，1-9 各 2 张', () => {
    for (const color of COLORS) {
      const numbers = deck.filter(
        (card) => card.color === color && card.type === CARD_TYPES.NUMBER,
      );
      assert.equal(numbers.filter((c) => c.value === 0).length, 1, '数字 0 应为 1 张');
      for (let value = 1; value <= 9; value += 1) {
        assert.equal(
          numbers.filter((c) => c.value === value).length,
          2,
          `${color} 的 ${value} 应为 2 张`,
        );
      }
      assert.equal(numbers.length, 19);
    }
  });

  it('每色跳过 / 反转 / 抽两张各 2 张', () => {
    for (const color of COLORS) {
      for (const type of [CARD_TYPES.SKIP, CARD_TYPES.REVERSE, CARD_TYPES.DRAW_TWO]) {
        const matches = deck.filter((c) => c.color === color && c.type === type);
        assert.equal(matches.length, 2, `${color} 的 ${type} 应为 2 张`);
      }
    }
  });

  it('变色 4 张、变色+4 4 张，且无颜色', () => {
    const wilds = deck.filter((c) => c.type === CARD_TYPES.WILD);
    const wild4s = deck.filter((c) => c.type === CARD_TYPES.WILD_DRAW_FOUR);
    assert.equal(wilds.length, 4);
    assert.equal(wild4s.length, 4);
    for (const card of [...wilds, ...wild4s]) {
      assert.equal(card.color, null, '万能牌不应带有颜色');
    }
  });

  it('已移除的复杂牌型不存在', () => {
    const removedTypes = ['swap', 'shuffle', 'custom'];
    for (const card of deck) {
      assert.ok(
        !removedTypes.includes(card.type),
        `不应存在已移除的牌型：${card.type}`,
      );
    }
  });

  it('每张牌的 id 唯一', () => {
    const ids = new Set(deck.map((c) => c.id));
    assert.equal(ids.size, DECK_SIZE);
  });

  it('数字牌以外的牌点数为 null，便于 JSON 传输', () => {
    for (const card of deck) {
      if (card.type === CARD_TYPES.NUMBER) {
        assert.equal(typeof card.value, 'number');
      } else {
        assert.equal(card.value, null);
      }
    }
  });

  it('牌面对象被冻结，无法在对局中被改写', () => {
    const sample = deck[0];
    assert.ok(Object.isFrozen(sample));
    assert.throws(() => {
      'use strict';
      sample.color = 'blue';
    }, TypeError);
  });
});

describe('洗牌', () => {
  it('洗牌不改变张数与牌的集合', () => {
    const deck = createDeck();
    const shuffled = shuffle(deck, createRng(7));

    assert.equal(shuffled.length, deck.length);

    const before = deck.map((c) => c.id).sort();
    const after = shuffled.map((c) => c.id).sort();
    assert.deepEqual(after, before);
  });

  it('不修改传入的数组', () => {
    const source = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const snapshot = source.map((c) => c.id);
    shuffle(source, createRng(1));
    assert.deepEqual(source.map((c) => c.id), snapshot);
  });

  it('同一随机源产生同一结果', () => {
    const a = shuffle(createDeck(), createRng(123));
    const b = shuffle(createDeck(), createRng(123));
    assert.deepEqual(
      a.map((c) => c.id),
      b.map((c) => c.id),
    );
  });

  it('不同种子产生不同牌序', () => {
    const a = shuffle(createDeck(), createRng(1)).map((c) => c.id);
    const b = shuffle(createDeck(), createRng(2)).map((c) => c.id);
    assert.notDeepEqual(a, b);
  });

  it('随机源返回 1 时不会越界', () => {
    const result = shuffle([{ id: 'a' }, { id: 'b' }, { id: 'c' }], () => 1);
    assert.equal(result.length, 3);
  });

  it('createShuffledDeck 无种子时也能产出完整牌组', () => {
    const deck = createShuffledDeck();
    assert.equal(deck.length, DECK_SIZE);
  });
});

describe('随机源', () => {
  it('输出落在 [0, 1) 区间', () => {
    const rng = createRng(99);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      assert.ok(value >= 0 && value < 1, `越界值：${value}`);
    }
  });

  it('分布大致均匀', () => {
    const rng = createRng(2024);
    const buckets = new Array(10).fill(0);
    const total = 10000;
    for (let i = 0; i < total; i += 1) {
      buckets[Math.floor(rng() * 10)] += 1;
    }
    for (const count of buckets) {
      assert.ok(
        count > total / 10 / 2 && count < (total / 10) * 1.5,
        `分布偏差过大：${count}`,
      );
    }
  });
});

describe('发牌', () => {
  it('两人局每人 7 张，牌堆剩 94 张', () => {
    const { hands, drawPile } = deal(createDeck(), 2);
    assert.equal(hands.length, 2);
    assert.equal(hands[0].length, CARDS_PER_PLAYER);
    assert.equal(hands[1].length, CARDS_PER_PLAYER);
    assert.equal(drawPile.length, DECK_SIZE - 2 * CARDS_PER_PLAYER);
  });

  it('四人局每人 7 张，牌堆剩 80 张', () => {
    const { hands, drawPile } = deal(createDeck(), 4);
    assert.equal(hands.length, 4);
    for (const hand of hands) {
      assert.equal(hand.length, CARDS_PER_PLAYER);
    }
    assert.equal(drawPile.length, DECK_SIZE - 4 * CARDS_PER_PLAYER);
  });

  it('发出去的牌加上牌堆等于完整牌组，且无重复', () => {
    const { hands, drawPile } = deal(createDeck(), 3);
    const all = [...hands.flat(), ...drawPile];
    assert.equal(all.length, DECK_SIZE);
    assert.equal(new Set(all.map((c) => c.id)).size, DECK_SIZE);
  });

  it('按轮次轮流发牌', () => {
    const fake = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const { hands, drawPile } = deal(fake, 2, 7);

    assert.deepEqual(
      hands[0].map((c) => c.id),
      [0, 2, 4, 6, 8, 10, 12],
    );
    assert.deepEqual(
      hands[1].map((c) => c.id),
      [1, 3, 5, 7, 9, 11, 13],
    );
    assert.deepEqual(
      drawPile.map((c) => c.id),
      [14, 15, 16, 17, 18, 19],
    );
  });

  it('玩家数量非法时抛出异常', () => {
    assert.throws(() => deal(createDeck(), 1), RangeError);
    assert.throws(() => deal(createDeck(), 5), RangeError);
    assert.throws(() => deal(createDeck(), 2.5), TypeError);
  });

  it('牌数不足时抛出异常', () => {
    assert.throws(() => deal([{ id: 'x' }], 2), RangeError);
  });
});
