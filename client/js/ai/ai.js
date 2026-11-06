/**
 * AI 对手决策。
 *
 * 三档难度：
 * - easy   随机出牌，不做任何保留，纯粹陪玩
 * - normal 优先出数字牌以保留功能牌；变色时选自己手上最多的颜色
 * - hard   在 normal 基础上观察对手手牌数量，对手牌少时优先打出 +2 / +4 / 跳过，
 *          变色时参考"该颜色已出掉多少张"来选对手更可能缺的颜色
 *
 * 所有决策都是纯函数，接收对局状态返回一个动作描述：
 * { action: 'play', cardId, color } | { action: 'draw' } | { action: 'pass' }
 */

import { CARD_TYPES, COLORS } from '../../../shared/constants.js';
import { PHASE, getPlayableCards, getTopCard } from '../../../shared/rules.js';

export const DIFFICULTY = Object.freeze({
  EASY: 'easy',
  NORMAL: 'normal',
  HARD: 'hard',
});

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** 下一家的座位号 */
function nextSeat(state) {
  const size = state.players.length;
  return (((state.currentPlayer + state.direction) % size) + size) % size;
}

/** 手牌中各颜色数量 */
function colorCounts(hand) {
  const counts = Object.fromEntries(COLORS.map((color) => [color, 0]));
  for (const card of hand) {
    if (card.color) counts[card.color] += 1;
  }
  return counts;
}

/** 手上是否还有当前颜色的牌（判断 +4 是否可出） */
function hasCurrentColor(hand, currentColor) {
  return hand.some((card) => card.color === currentColor);
}

/** 选择要指定的颜色 */
function pickColor(state, hand, difficulty) {
  const counts = colorCounts(hand);
  const max = Math.max(...COLORS.map((color) => counts[color]));
  const best = COLORS.filter((color) => counts[color] === max);

  if (difficulty === DIFFICULTY.EASY) {
    return randomOf(COLORS);
  }

  if (best.length === 1) {
    return best[0];
  }

  if (difficulty === DIFFICULTY.NORMAL) {
    return randomOf(best);
  }

  // hard：在并列最优的颜色里，选已经出掉最多的（剩余牌堆里更少，对手更难跟）
  const playedByColor = Object.fromEntries(COLORS.map((color) => [color, 0]));
  for (const card of state.discardPile) {
    if (card.color) playedByColor[card.color] += 1;
  }
  return best.sort((a, b) => playedByColor[b] - playedByColor[a])[0];
}

/**
 * 给一张牌打分，分越高越优先打出。
 * 只用于 normal / hard。
 */
function scoreCard(card, state, hand) {
  const size = state.players.length;
  const nextHandSize = state.players[nextSeat(state)].hand.length;
  const isEndgame = nextHandSize <= 2;
  let score = 0;

  switch (card.type) {
    case CARD_TYPES.NUMBER:
      // 数字牌优先出掉，把功能牌留到关键回合
      score += 10;
      break;
    case CARD_TYPES.SKIP:
      score += isEndgame ? 38 : 6;
      break;
    case CARD_TYPES.REVERSE:
      score += isEndgame ? 26 : 8;
      break;
    case CARD_TYPES.DRAW_TWO:
      score += isEndgame ? 46 : 14;
      break;
    case CARD_TYPES.WILD:
      // 万能牌能留就留，实在没得打才用
      score -= 10;
      break;
    case CARD_TYPES.WILD_DRAW_FOUR:
      score += isEndgame ? 60 : -16;
      break;
    default:
      break;
  }

  // 优先打出自己手上数量最多的颜色，保住稀缺色
  if (card.color) {
    const sameColor = hand.filter((item) => item.color === card.color).length;
    score += sameColor * 0.6;
  }

  // 两人局势均力敌时，反转牌等同于自己再出一轮，价值更高
  if (size === 2 && card.type === CARD_TYPES.REVERSE) {
    score += 12;
  }

  // 加一点抖动，避免每局行为完全一致、显得机械
  return score + Math.random() * 3;
}

/** 从可出牌中挑一张 */
function selectCard(state, playable, difficulty) {
  if (difficulty === DIFFICULTY.EASY) {
    return randomOf(playable);
  }

  const hand = state.players[state.currentPlayer].hand;
  let best = playable[0];
  let bestScore = -Infinity;

  for (const card of playable) {
    // +4 在不紧急时不该浪费：只有手上没有同色牌才可能出现在 playable 里
    const score = scoreCard(card, state, hand);
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }

  return best;
}

/** 摸到牌后是否值得立刻打出 */
function shouldPlayDrawn(card, state, difficulty) {
  if (difficulty === DIFFICULTY.EASY) {
    return Math.random() < 0.8;
  }
  if (card.type === CARD_TYPES.WILD) {
    // 普通难度倾向于留着万能牌
    return difficulty === DIFFICULTY.HARD && state.players[state.currentPlayer].hand.length <= 2;
  }
  return true;
}

/**
 * 计算下一步动作。
 * @param {object} state 对局状态
 * @param {'easy'|'normal'|'hard'} difficulty 难度
 */
export function chooseMove(state, difficulty = DIFFICULTY.NORMAL) {
  const seat = state.currentPlayer;
  const me = state.players[seat];
  const topCard = getTopCard(state);
  const ctx = { topCard, currentColor: state.currentColor };
  const playable = getPlayableCards(me.hand, ctx);

  // 已摸牌：只能在"打出刚摸到的那张"和"过牌"之间选
  if (state.phase === PHASE.DRAWN) {
    const drawn = me.hand.find((card) => card.id === state.drawnCardId);
    if (!drawn) return { action: 'pass' };

    const drawnPlayable = playable.some((card) => card.id === drawn.id);
    if (!drawnPlayable) return { action: 'pass' };

    if (!shouldPlayDrawn(drawn, state, difficulty)) return { action: 'pass' };

    const needsColor =
      drawn.type === CARD_TYPES.WILD || drawn.type === CARD_TYPES.WILD_DRAW_FOUR;
    return {
      action: 'play',
      cardId: drawn.id,
      color: needsColor ? pickColor(state, me.hand, difficulty) : undefined,
    };
  }

  if (playable.length === 0) {
    return { action: 'draw' };
  }

  // 手上有当前颜色的牌时 +4 本来就不合法，这里再做一层保护
  const legal = playable.filter((card) => {
    if (card.type !== CARD_TYPES.WILD_DRAW_FOUR) return true;
    return !hasCurrentColor(me.hand, state.currentColor);
  });

  const pool = legal.length > 0 ? legal : playable;
  const card = selectCard(state, pool, difficulty);
  const needsColor =
    card.type === CARD_TYPES.WILD || card.type === CARD_TYPES.WILD_DRAW_FOUR;

  return {
    action: 'play',
    cardId: card.id,
    color: needsColor ? pickColor(state, me.hand, difficulty) : undefined,
  };
}
