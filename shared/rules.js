/**
 * UNO 规则引擎：出牌合法性判定与回合状态机。
 *
 * 这是整个项目最核心的模块，前端单机模式与联机服务端共用同一份实现，
 * 因此不存在"我这边显示能出、服务器说不行"的分裂。
 *
 * 约定：
 * - 所有操作函数都是纯函数，接收旧状态返回新状态，绝不修改入参；
 * - 非法操作抛出 GameError，带机器可读的 code，便于界面提示与测试断言；
 * - drawPile[0] 是下一张要摸的牌（牌堆顶部）。
 */

import {
  CARD_LABELS,
  CARD_TYPES,
  COLOR_LABELS,
  CARDS_PER_PLAYER,
  COLORS,
  MAX_PLAYERS,
  MIN_PLAYERS,
} from './constants.js';
import { createRng, createShuffledDeck, deal, shuffle } from './deck.js';

/** 对局阶段 */
export const PHASE = Object.freeze({
  /** 等待当前玩家出牌或摸牌 */
  PLAYING: 'playing',
  /** 已摸牌，且摸到的牌可出，等待玩家决定出牌还是过牌 */
  DRAWN: 'drawn',
  /** 对局结束 */
  FINISHED: 'finished',
});

/** 非法操作错误码 */
export const ERROR_CODES = Object.freeze({
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  CARD_NOT_IN_HAND: 'CARD_NOT_IN_HAND',
  ILLEGAL_MOVE: 'ILLEGAL_MOVE',
  INVALID_COLOR: 'INVALID_COLOR',
  MUST_DECIDE_DRAWN_CARD: 'MUST_DECIDE_DRAWN_CARD',
  GAME_FINISHED: 'GAME_FINISHED',
  WRONG_PHASE: 'WRONG_PHASE',
  INVALID_PLAYERS: 'INVALID_PLAYERS',
});

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  查询工具                                   */
/* -------------------------------------------------------------------------- */

/** 取牌堆顶（最后打出）的牌 */
export function getTopCard(state) {
  return state.discardPile[state.discardPile.length - 1];
}

/** 取当前行动玩家 */
export function getCurrentPlayer(state) {
  return state.players[state.currentPlayer];
}

/** 判断一张牌是否可以打在当前桌面上 */
export function isPlayable(card, { topCard, currentColor, hand = [] }) {
  // 变色牌随时可出
  if (card.type === CARD_TYPES.WILD) {
    return true;
  }

  // 变色+4：手上有当前颜色的牌时不可出（不做质疑机制，直接禁掉非法操作）
  if (card.type === CARD_TYPES.WILD_DRAW_FOUR) {
    return !hand.some((item) => item.id !== card.id && item.color === currentColor);
  }

  // 同色必可出
  if (card.color === currentColor) {
    return true;
  }

  // 桌面是数字牌：同数字可出
  if (topCard.type === CARD_TYPES.NUMBER && card.type === CARD_TYPES.NUMBER) {
    return card.value === topCard.value;
  }

  // 桌面是功能牌：同类型可出（跳过压跳过、反转压反转、+2 压 +2）
  if (topCard.type !== CARD_TYPES.NUMBER && card.type === topCard.type) {
    return true;
  }

  return false;
}

/** 结出某玩家手上所有可出的牌 */
export function getPlayableCards(hand, { topCard, currentColor }) {
  return hand.filter((card) => isPlayable(card, { topCard, currentColor, hand }));
}

/** 某玩家是否还有牌可出 */
export function hasPlayableCard(state, playerIndex) {
  const player = state.players[playerIndex];
  return (
    getPlayableCards(player.hand, {
      topCard: getTopCard(state),
      currentColor: state.currentColor,
    }).length > 0
  );
}

/* -------------------------------------------------------------------------- */
/*                                  内部工具                                   */
/* -------------------------------------------------------------------------- */

/** 复制一份状态，保证纯函数语义 */
function cloneState(state) {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      hand: [...player.hand],
    })),
    drawPile: [...state.drawPile],
    discardPile: [...state.discardPile],
    log: [...state.log],
  };
}

/** 从当前玩家出发，沿当前方向前进 steps 个座位 */
function offsetIndex(state, index, steps) {
  const size = state.players.length;
  return (((index + state.direction * steps) % size) + size) % size;
}

/**
 * 摸牌堆空了就把弃牌堆洗回来（保留最上面那张）。
 * 用种子加洗牌次数生成随机源，保证对局可复现。
 */
function reshuffleDiscardIntoDrawPile(state) {
  if (state.discardPile.length <= 1) {
    return;
  }
  const top = state.discardPile.pop();
  const recycled = state.discardPile.splice(0, state.discardPile.length);
  state.reshuffleCount += 1;
  state.drawPile.push(...shuffle(recycled, createRng(state.seed + state.reshuffleCount)));
  state.discardPile.push(top);
  state.log.push('摸牌堆用尽，弃牌堆已重新洗混');
}

/** 从摸牌堆取 count 张，返回取到的牌 */
function takeCards(state, count) {
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    if (state.drawPile.length === 0) {
      reshuffleDiscardIntoDrawPile(state);
    }
    if (state.drawPile.length === 0) {
      break; // 牌全部集中在玩家手上，实在没牌可摸
    }
    drawn.push(state.drawPile.shift());
  }
  return drawn;
}

/** 生成一句对战日志 */
function describeCard(card, chosenColor) {
  const color = card.color
    ? COLOR_LABELS[card.color]
    : chosenColor
      ? `指定${COLOR_LABELS[chosenColor]}`
      : '万能';
  if (card.type === CARD_TYPES.NUMBER) {
    return `${color} ${card.value}`;
  }
  return `${color} ${CARD_LABELS[card.type]}`;
}

/** 前进到下一个行动玩家 */
function advanceTurn(state, steps = 1) {
  state.currentPlayer = offsetIndex(state, state.currentPlayer, steps);
  state.phase = PHASE.PLAYING;
  state.drawnCardId = null;
}

/* -------------------------------------------------------------------------- */
/*                                  开局                                       */
/* -------------------------------------------------------------------------- */

/**
 * 创建一局新游戏。
 * @param {{players: {name: string, isAI?: boolean}[], seed?: number}} config
 */
export function createGame({ players, seed = Math.floor(Math.random() * 1e9) }) {
  if (!Array.isArray(players)) {
    throw new GameError(ERROR_CODES.INVALID_PLAYERS, '玩家列表必须是数组');
  }
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new GameError(
      ERROR_CODES.INVALID_PLAYERS,
      `玩家人数必须在 ${MIN_PLAYERS}-${MAX_PLAYERS} 之间`,
    );
  }

  const deck = createShuffledDeck(seed);
  const { hands, drawPile } = deal(deck, players.length, CARDS_PER_PLAYER);

  // 起始牌必须是数字牌：翻到万能牌就压到牌堆底部重翻，保证开局桌面颜色明确
  const skipped = [];
  let topCard = drawPile.shift();
  while (topCard && topCard.type !== CARD_TYPES.NUMBER) {
    skipped.push(topCard);
    topCard = drawPile.shift();
  }
  if (!topCard) {
    throw new GameError(ERROR_CODES.INVALID_PLAYERS, '牌组异常：找不到可作为起始牌的数字牌');
  }
  drawPile.push(...skipped);

  return {
    seed,
    reshuffleCount: 0,
    players: players.map((player, index) => ({
      id: `p${index + 1}`,
      name: player.name ?? `玩家${index + 1}`,
      isAI: Boolean(player.isAI),
      hand: hands[index],
    })),
    drawPile,
    discardPile: [topCard],
    currentColor: topCard.color,
    direction: 1,
    currentPlayer: 0,
    phase: PHASE.PLAYING,
    drawnCardId: null,
    winnerId: null,
    turnCount: 0,
    log: [`开局，桌面起始牌为 ${describeCard(topCard)}`],
  };
}

/* -------------------------------------------------------------------------- */
/*                                  出牌                                       */
/* -------------------------------------------------------------------------- */

/**
 * 打出一张牌。
 * @param {object} state 当前状态
 * @param {number} playerIndex 出牌玩家座位号
 * @param {string} cardId 要出的牌 id
 * @param {string} [chosenColor] 万能牌指定的颜色
 */
export function playCard(state, playerIndex, cardId, chosenColor) {
  if (state.phase === PHASE.FINISHED) {
    throw new GameError(ERROR_CODES.GAME_FINISHED, '对局已结束');
  }
  if (playerIndex !== state.currentPlayer) {
    throw new GameError(ERROR_CODES.NOT_YOUR_TURN, '还没轮到你出牌');
  }

  const player = state.players[playerIndex];
  const card = player.hand.find((item) => item.id === cardId);
  if (!card) {
    throw new GameError(ERROR_CODES.CARD_NOT_IN_HAND, '这张牌不在你的手上');
  }

  // 摸牌后只能决定"出刚摸到的那张"或"过牌"，不能改出别的牌
  if (state.phase === PHASE.DRAWN && state.drawnCardId !== cardId) {
    throw new GameError(
      ERROR_CODES.MUST_DECIDE_DRAWN_CARD,
      '已摸牌，本回合只能打出刚摸到的牌或选择过牌',
    );
  }

  const topCard = getTopCard(state);
  if (!isPlayable(card, { topCard, currentColor: state.currentColor, hand: player.hand })) {
    throw new GameError(ERROR_CODES.ILLEGAL_MOVE, '这张牌不符合出牌规则');
  }

  const isWild = card.type === CARD_TYPES.WILD || card.type === CARD_TYPES.WILD_DRAW_FOUR;
  if (isWild && !COLORS.includes(chosenColor)) {
    throw new GameError(ERROR_CODES.INVALID_COLOR, '打出万能牌必须指定一个有效颜色');
  }

  const next = cloneState(state);
  const actor = next.players[playerIndex];

  // 从手牌移除并放上弃牌堆
  actor.hand = actor.hand.filter((item) => item.id !== cardId);
  next.discardPile.push(card);
  next.currentColor = isWild ? chosenColor : card.color;
  next.turnCount += 1;
  next.log.push(`${actor.name} 打出 ${describeCard(card, chosenColor)}`);

  // 出完最后一张即获胜
  if (actor.hand.length === 0) {
    next.phase = PHASE.FINISHED;
    next.winnerId = actor.id;
    next.log.push(`${actor.name} 出完了所有手牌，获得胜利！`);
    return next;
  }

  const size = next.players.length;

  switch (card.type) {
    case CARD_TYPES.SKIP:
      // 跳过下一家
      advanceTurn(next, 2);
      break;

    case CARD_TYPES.REVERSE:
      if (size === 2) {
        // 两人局时反转等同于跳过，由出牌者继续出牌
        advanceTurn(next, 2);
      } else {
        next.direction *= -1;
        advanceTurn(next, 1);
      }
      break;

    case CARD_TYPES.DRAW_TWO: {
      const victim = next.players[offsetIndex(next, next.currentPlayer, 1)];
      const drawn = takeCards(next, 2);
      victim.hand.push(...drawn);
      next.log.push(`${victim.name} 摸 2 张并跳过回合`);
      advanceTurn(next, 2);
      break;
    }

    case CARD_TYPES.WILD_DRAW_FOUR: {
      const victim = next.players[offsetIndex(next, next.currentPlayer, 1)];
      const drawn = takeCards(next, 4);
      victim.hand.push(...drawn);
      next.log.push(`${victim.name} 摸 4 张并跳过回合`);
      advanceTurn(next, 2);
      break;
    }

    default:
      advanceTurn(next, 1);
      break;
  }

  return next;
}

/* -------------------------------------------------------------------------- */
/*                                  摸牌                                       */
/* -------------------------------------------------------------------------- */

/**
 * 摸一张牌。
 * 摸到可出的牌时进入 DRAWN 阶段，由玩家决定是否打出；否则自动结束回合。
 */
export function drawCard(state, playerIndex) {
  if (state.phase === PHASE.FINISHED) {
    throw new GameError(ERROR_CODES.GAME_FINISHED, '对局已结束');
  }
  if (playerIndex !== state.currentPlayer) {
    throw new GameError(ERROR_CODES.NOT_YOUR_TURN, '还没轮到你摸牌');
  }
  if (state.phase === PHASE.DRAWN) {
    throw new GameError(ERROR_CODES.WRONG_PHASE, '本回合已经摸过牌了');
  }

  const next = cloneState(state);
  const actor = next.players[playerIndex];
  const [drawn] = takeCards(next, 1);

  if (!drawn) {
    // 牌堆与弃牌堆都空了，只能直接过牌
    next.log.push(`${actor.name} 摸牌失败，牌堆已空，跳过回合`);
    advanceTurn(next, 1);
    return next;
  }

  actor.hand.push(drawn);
  next.log.push(`${actor.name} 摸了一张牌`);

  const playable = isPlayable(drawn, {
    topCard: getTopCard(next),
    currentColor: next.currentColor,
    hand: actor.hand,
  });

  if (playable) {
    next.phase = PHASE.DRAWN;
    next.drawnCardId = drawn.id;
  } else {
    advanceTurn(next, 1);
  }

  return next;
}

/**
 * 摸牌后选择过牌，不再出牌。
 */
export function passAfterDraw(state, playerIndex) {
  if (state.phase === PHASE.FINISHED) {
    throw new GameError(ERROR_CODES.GAME_FINISHED, '对局已结束');
  }
  if (playerIndex !== state.currentPlayer) {
    throw new GameError(ERROR_CODES.NOT_YOUR_TURN, '还没轮到你');
  }
  if (state.phase !== PHASE.DRAWN) {
    throw new GameError(ERROR_CODES.WRONG_PHASE, '当前不需要做这个选择');
  }

  const next = cloneState(state);
  next.log.push(`${next.players[playerIndex].name} 选择跳过`);
  advanceTurn(next, 1);
  return next;
}

/** 是否已结束 */
export function isFinished(state) {
  return state.phase === PHASE.FINISHED;
}
