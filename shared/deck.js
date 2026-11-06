/**
 * 牌组构建、洗牌与发牌。
 *
 * 设计原则：
 * 1. 所有函数均为纯函数，不修改传入参数，只返回新对象；
 * 2. 随机源可注入，便于单元测试与联机回放时复现同一局牌序；
 * 3. 牌面对象被冻结，避免对局过程中被意外改写。
 */

import {
  ACTIVE_ACTION_TYPES,
  CARD_TYPES,
  CARDS_PER_PLAYER,
  COLORS,
  DECK_SIZE,
  DECK_SPEC,
  MAX_PLAYERS,
  MIN_PLAYERS,
} from './constants.js';

/** 把 0 起的序号转成 a / b / c …，用于给同名牌加唯一后缀 */
function suffix(index) {
  return String.fromCharCode(97 + index);
}

/**
 * 构造一张有色牌（数字牌或功能牌）。
 * @param {string} color 颜色
 * @param {string} type 牌型
 * @param {number|undefined} value 数字牌的点数，功能牌传 undefined
 * @param {number} copy 同名牌的副本序号
 */
function buildColoredCard(color, type, value, copy) {
  const point = value === undefined ? null : value;
  const id =
    point === null
      ? `${color}-${type}-${suffix(copy)}`
      : `${color}-${type}-${point}-${suffix(copy)}`;

  return Object.freeze({ id, color, type, value: point });
}

/** 构造一张万能牌（无颜色）。 */
function buildWildCard(type, copy) {
  return Object.freeze({
    id: `${type}-${suffix(copy)}`,
    color: null,
    type,
    value: null,
  });
}

/**
 * 生成一副完整的 108 张标准牌组（已去掉换手牌、洗牌重发、自定规则牌）。
 * @returns {ReadonlyArray<object>} 未洗牌的有序牌组
 */
export function createDeck() {
  /** @type {object[]} */
  const deck = [];

  for (const color of COLORS) {
    // 数字 0：每色 1 张
    for (let copy = 0; copy < DECK_SPEC.zeroCopies; copy += 1) {
      deck.push(buildColoredCard(color, CARD_TYPES.NUMBER, 0, copy));
    }
    // 数字 1-9：每色各 2 张
    for (let value = 1; value <= 9; value += 1) {
      for (let copy = 0; copy < DECK_SPEC.numberCopies; copy += 1) {
        deck.push(buildColoredCard(color, CARD_TYPES.NUMBER, value, copy));
      }
    }
    // 跳过 / 反转 / 抽两张：每色各 2 张
    for (const type of ACTIVE_ACTION_TYPES) {
      for (let copy = 0; copy < DECK_SPEC.actionCopies; copy += 1) {
        deck.push(buildColoredCard(color, type, undefined, copy));
      }
    }
  }

  // 万能牌：变色 4 张，变色+4 4 张
  for (let copy = 0; copy < DECK_SPEC.wildCopies; copy += 1) {
    deck.push(buildWildCard(CARD_TYPES.WILD, copy));
  }
  for (let copy = 0; copy < DECK_SPEC.wildDrawFourCopies; copy += 1) {
    deck.push(buildWildCard(CARD_TYPES.WILD_DRAW_FOUR, copy));
  }

  return Object.freeze(deck);
}

/**
 * Fisher-Yates 洗牌，返回新数组，不修改原数组。
 * @param {ReadonlyArray<object>} cards 待洗的牌
 * @param {() => number} rng 随机源，须返回 [0, 1) 区间的数
 * @returns {object[]} 洗好的新数组
 */
export function shuffle(cards, rng = Math.random) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i -= 1) {
    // 夹紧上界，防止注入的随机源返回 1 时下标越界
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

/**
 * 由种子生成确定性随机源（mulberry32）。
 * 同一个种子必然产生同一串随机数，用于测试与对局回放。
 * @param {number} seed 种子
 * @returns {() => number}
 */
export function createRng(seed = 1) {
  let state = seed >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一副洗好的牌组。
 * @param {number} [seed] 指定种子可复现同一牌序；不传则真随机
 * @returns {object[]}
 */
export function createShuffledDeck(seed) {
  const rng = seed === undefined ? Math.random : createRng(seed);
  return shuffle(createDeck(), rng);
}

/**
 * 按顺序轮流发牌。
 * @param {ReadonlyArray<object>} cards 洗好的牌组
 * @param {number} playerCount 玩家数量，2-4
 * @param {number} [perPlayer] 每人发牌数，默认 7
 * @returns {{hands: object[][], drawPile: object[]}}
 */
export function deal(cards, playerCount, perPlayer = CARDS_PER_PLAYER) {
  if (!Number.isInteger(playerCount)) {
    throw new TypeError(`玩家数量必须是整数，收到：${playerCount}`);
  }
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new RangeError(
      `玩家数量必须在 ${MIN_PLAYERS}-${MAX_PLAYERS} 之间，收到：${playerCount}`,
    );
  }

  const needed = playerCount * perPlayer;
  if (cards.length < needed) {
    throw new RangeError(
      `牌数不足：需要 ${needed} 张，实际只有 ${cards.length} 张`,
    );
  }

  const hands = Array.from({ length: playerCount }, () => []);
  let cursor = 0;

  // 逐轮发牌，保证每人张数一致
  for (let round = 0; round < perPlayer; round += 1) {
    for (let player = 0; player < playerCount; player += 1) {
      hands[player].push(cards[cursor]);
      cursor += 1;
    }
  }

  return {
    hands,
    drawPile: cards.slice(cursor),
  };
}

/** 牌组总张数，供测试与界面展示引用 */
export { DECK_SIZE };
