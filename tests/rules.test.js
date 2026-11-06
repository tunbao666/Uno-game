/**
 * 规则引擎单元测试。
 * 覆盖：开局、合法性判定、各类功能牌效果、摸牌流程、胜负判定、状态不可变性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_CODES,
  GameError,
  PHASE,
  createGame,
  drawCard,
  getPlayableCards,
  getTopCard,
  hasPlayableCard,
  isPlayable,
  passAfterDraw,
  playCard,
} from '../shared/rules.js';
import { CARD_TYPES, DECK_SIZE } from '../shared/constants.js';

/* --------------------------------- 构造工具 -------------------------------- */

const num = (id, color, value) => ({ id, color, type: CARD_TYPES.NUMBER, value });
const act = (id, color, type) => ({ id, color, type, value: null });
const wild = (id, type = CARD_TYPES.WILD) => ({ id, color: null, type, value: null });

function stateWith({
  hands,
  top,
  color,
  drawPile = [],
  currentPlayer = 0,
  direction = 1,
}) {
  return {
    seed: 1,
    reshuffleCount: 0,
    players: hands.map((hand, index) => ({
      id: `p${index + 1}`,
      name: `玩家${index + 1}`,
      isAI: false,
      hand,
    })),
    drawPile,
    discardPile: [top],
    currentColor: color ?? top.color,
    direction,
    currentPlayer,
    phase: PHASE.PLAYING,
    drawnCardId: null,
    winnerId: null,
    turnCount: 0,
    log: [],
  };
}

/** 生成 n 张用于被摸的垫牌（颜色与桌面不同，避免误判可出） */
function filler(count) {
  return Array.from({ length: count }, (_, i) => num(`f${i}`, 'green', 1));
}

/* ---------------------------------- 开局 ---------------------------------- */

describe('开局', () => {
  it('两人局：各 7 张，桌面 1 张，剩余牌堆 93 张', () => {
    const game = createGame({ players: [{ name: 'A' }, { name: 'B' }], seed: 42 });
    assert.equal(game.players.length, 2);
    assert.equal(game.players[0].hand.length, 7);
    assert.equal(game.players[1].hand.length, 7);
    assert.equal(game.discardPile.length, 1);
    assert.equal(game.drawPile.length, DECK_SIZE - 14 - 1);
  });

  it('四人局：各 7 张，剩余牌堆 79 张', () => {
    const game = createGame({
      players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
      seed: 7,
    });
    assert.equal(game.players.length, 4);
    for (const player of game.players) {
      assert.equal(player.hand.length, 7);
    }
    assert.equal(game.drawPile.length, DECK_SIZE - 28 - 1);
  });

  it('整副牌 108 张全部有归属', () => {
    const game = createGame({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed: 99 });
    const total =
      game.players.reduce((sum, p) => sum + p.hand.length, 0) +
      game.drawPile.length +
      game.discardPile.length;
    assert.equal(total, DECK_SIZE);
  });

  it('起始牌一定是数字牌，且已确定当前颜色', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const game = createGame({ players: [{ name: 'A' }, { name: 'B' }], seed });
      const top = getTopCard(game);
      assert.equal(top.type, CARD_TYPES.NUMBER, `种子 ${seed} 的起始牌不是数字牌`);
      assert.equal(game.currentColor, top.color);
    }
  });

  it('相同种子产生完全相同的开局', () => {
    const a = createGame({ players: [{ name: 'A' }, { name: 'B' }], seed: 2024 });
    const b = createGame({ players: [{ name: 'A' }, { name: 'B' }], seed: 2024 });
    assert.deepEqual(
      a.players.map((p) => p.hand.map((c) => c.id)),
      b.players.map((p) => p.hand.map((c) => c.id)),
    );
  });

  it('玩家人数非法时抛出 GameError', () => {
    assert.throws(() => createGame({ players: [{ name: 'A' }] }), GameError);
    assert.throws(
      () => createGame({ players: Array.from({ length: 5 }, (_, i) => ({ name: `P${i}` })) }),
      GameError,
    );
  });

  it('开局由 0 号座位先行动，方向为顺时针', () => {
    const game = createGame({ players: [{ name: 'A' }, { name: 'B' }], seed: 5 });
    assert.equal(game.currentPlayer, 0);
    assert.equal(game.direction, 1);
    assert.equal(game.phase, PHASE.PLAYING);
  });
});

/* ------------------------------- 合法性判定 -------------------------------- */

describe('出牌合法性', () => {
  const topCard = num('t', 'red', 7);

  it('同色可出', () => {
    assert.ok(isPlayable(num('a', 'red', 3), { topCard, currentColor: 'red' }));
  });

  it('同数字不同色可出', () => {
    assert.ok(isPlayable(num('a', 'blue', 7), { topCard, currentColor: 'red' }));
  });

  it('异色异数字不可出', () => {
    assert.ok(!isPlayable(num('a', 'blue', 3), { topCard, currentColor: 'red' }));
  });

  it('同色功能牌可出', () => {
    assert.ok(isPlayable(act('a', 'red', CARD_TYPES.SKIP), { topCard, currentColor: 'red' }));
  });

  it('异色功能牌不可出（桌面是数字牌）', () => {
    assert.ok(!isPlayable(act('a', 'blue', CARD_TYPES.SKIP), { topCard, currentColor: 'red' }));
  });

  it('桌面是功能牌时，同类型可出', () => {
    const skipTop = act('t2', 'red', CARD_TYPES.SKIP);
    assert.ok(
      isPlayable(act('a', 'blue', CARD_TYPES.SKIP), {
        topCard: skipTop,
        currentColor: 'red',
      }),
    );
    assert.ok(
      !isPlayable(act('a', 'blue', CARD_TYPES.REVERSE), {
        topCard: skipTop,
        currentColor: 'red',
      }),
    );
  });

  it('变色牌随时可出', () => {
    assert.ok(isPlayable(wild('w'), { topCard, currentColor: 'red' }));
  });

  it('手上有当前颜色时，变色+4 不可出', () => {
    const hand = [wild('w4', CARD_TYPES.WILD_DRAW_FOUR), num('b', 'red', 2)];
    assert.ok(!isPlayable(wild('w4', CARD_TYPES.WILD_DRAW_FOUR), {
      topCard,
      currentColor: 'red',
      hand,
    }));
  });

  it('手上没有当前颜色时，变色+4 可出', () => {
    const hand = [wild('w4', CARD_TYPES.WILD_DRAW_FOUR), num('b', 'blue', 2)];
    assert.ok(isPlayable(wild('w4', CARD_TYPES.WILD_DRAW_FOUR), {
      topCard,
      currentColor: 'red',
      hand,
    }));
  });

  it('getPlayableCards 只返回可出的牌', () => {
    const hand = [num('a', 'red', 1), num('b', 'blue', 2), num('c', 'green', 7), wild('w')];
    const playable = getPlayableCards(hand, { topCard, currentColor: 'red' }).map((c) => c.id);
    assert.deepEqual(playable.sort(), ['a', 'c', 'w'].sort());
  });

  it('hasPlayableCard 判断整手牌是否有牌可出', () => {
    const blocked = stateWith({
      hands: [[num('a', 'blue', 1)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
    });
    assert.equal(hasPlayableCard(blocked, 0), false);

    const open = stateWith({
      hands: [[num('a', 'red', 1)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
    });
    assert.equal(hasPlayableCard(open, 0), true);
  });
});

/* --------------------------------- 出牌流程 -------------------------------- */

describe('出牌与回合推进', () => {
  it('出普通牌后轮到下一家', () => {
    const state = stateWith({
      hands: [
        [num('a', 'red', 3), num('x', 'blue', 1)],
        [num('b', 'blue', 2)],
        [num('c', 'green', 4)],
      ],
      top: num('t', 'red', 7),
    });

    const next = playCard(state, 0, 'a', undefined);
    assert.equal(next.currentPlayer, 1);
    assert.equal(next.discardPile.length, 2);
    assert.equal(next.players[0].hand.length, 1);
    assert.equal(next.turnCount, 1);
  });

  it('不修改原状态（纯函数）', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3), num('x', 'blue', 1)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
    });
    const before = JSON.stringify(state);
    playCard(state, 0, 'a', undefined);
    assert.equal(JSON.stringify(state), before);
  });

  it('不是自己的回合时抛出错误', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3)], [num('b', 'red', 4)]],
      top: num('t', 'red', 7),
    });
    assert.throws(
      () => playCard(state, 1, 'b', undefined),
      (err) => err instanceof GameError && err.code === ERROR_CODES.NOT_YOUR_TURN,
    );
  });

  it('打出不在手上的牌时抛出错误', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3)], [num('b', 'red', 4)]],
      top: num('t', 'red', 7),
    });
    assert.throws(
      () => playCard(state, 0, 'nope', undefined),
      (err) => err.code === ERROR_CODES.CARD_NOT_IN_HAND,
    );
  });

  it('打出不符合规则的牌时抛出错误', () => {
    const state = stateWith({
      hands: [[num('a', 'blue', 3)], [num('b', 'red', 4)]],
      top: num('t', 'red', 7),
    });
    assert.throws(
      () => playCard(state, 0, 'a', undefined),
      (err) => err.code === ERROR_CODES.ILLEGAL_MOVE,
    );
  });
});

/* -------------------------------- 功能牌效果 ------------------------------- */

describe('功能牌效果', () => {
  it('跳过：下一家被跳过', () => {
    const state = stateWith({
      hands: [
        [act('s', 'red', CARD_TYPES.SKIP), num('a', 'blue', 1)],
        [num('b', 'blue', 2)],
        [num('c', 'blue', 3)],
      ],
      top: num('t', 'red', 7),
    });
    const next = playCard(state, 0, 's', undefined);
    assert.equal(next.currentPlayer, 2);
  });

  it('反转（三人局）：方向反向，轮到上家', () => {
    const state = stateWith({
      hands: [
        [act('r', 'red', CARD_TYPES.REVERSE), num('a', 'blue', 1)],
        [num('b', 'blue', 2)],
        [num('c', 'blue', 3)],
      ],
      top: num('t', 'red', 7),
    });
    const next = playCard(state, 0, 'r', undefined);
    assert.equal(next.direction, -1);
    assert.equal(next.currentPlayer, 2);
  });

  it('反转（两人局）：等同跳过，自己继续出牌', () => {
    const state = stateWith({
      hands: [
        [act('r', 'red', CARD_TYPES.REVERSE), num('a', 'blue', 1)],
        [num('b', 'blue', 2)],
      ],
      top: num('t', 'red', 7),
    });
    const next = playCard(state, 0, 'r', undefined);
    assert.equal(next.currentPlayer, 0);
    assert.equal(next.direction, 1, '两人局不应改变方向，避免死循环');
  });

  it('抽两张：下一家摸 2 张并跳过', () => {
    const state = stateWith({
      hands: [
        [act('d', 'red', CARD_TYPES.DRAW_TWO), num('a', 'blue', 1)],
        [num('b', 'blue', 2)],
        [num('c', 'blue', 3)],
      ],
      top: num('t', 'red', 7),
      drawPile: filler(5),
    });
    const next = playCard(state, 0, 'd', undefined);
    assert.equal(next.players[1].hand.length, 3);
    assert.equal(next.drawPile.length, 3);
    assert.equal(next.currentPlayer, 2);
  });

  it('变色：未指定颜色时抛出错误', () => {
    const state = stateWith({
      hands: [[wild('w'), num('a', 'blue', 1)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
    });
    assert.throws(
      () => playCard(state, 0, 'w', undefined),
      (err) => err.code === ERROR_CODES.INVALID_COLOR,
    );
  });

  it('变色：指定颜色后当前颜色随之改变', () => {
    const state = stateWith({
      hands: [[wild('w'), num('a', 'blue', 1)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
    });
    const next = playCard(state, 0, 'w', 'blue');
    assert.equal(next.currentColor, 'blue');
    assert.equal(next.currentPlayer, 1);
  });

  it('变色+4：下一家摸 4 张并跳过', () => {
    const state = stateWith({
      hands: [
        [wild('w4', CARD_TYPES.WILD_DRAW_FOUR), num('a', 'blue', 1)],
        [num('b', 'blue', 2)],
        [num('c', 'blue', 3)],
      ],
      top: num('t', 'red', 7),
      drawPile: filler(6),
    });
    const next = playCard(state, 0, 'w4', 'green');
    assert.equal(next.players[1].hand.length, 5);
    assert.equal(next.drawPile.length, 2);
    assert.equal(next.currentPlayer, 2);
    assert.equal(next.currentColor, 'green');
  });

  it('变色+4：手上有当前颜色时无法打出', () => {
    const state = stateWith({
      hands: [
        [wild('w4', CARD_TYPES.WILD_DRAW_FOUR), num('a', 'red', 1)],
        [num('b', 'blue', 2)],
      ],
      top: num('t', 'red', 7),
    });
    assert.throws(
      () => playCard(state, 0, 'w4', 'blue'),
      (err) => err.code === ERROR_CODES.ILLEGAL_MOVE,
    );
  });
});

/* --------------------------------- 摸牌流程 -------------------------------- */

describe('摸牌流程', () => {
  it('摸到不能出的牌时自动结束回合', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
      drawPile: [num('z', 'green', 9)],
    });
    const next = drawCard(state, 0);
    assert.equal(next.players[0].hand.length, 2);
    assert.equal(next.phase, PHASE.PLAYING);
    assert.equal(next.currentPlayer, 1);
    assert.equal(next.drawnCardId, null);
  });

  it('摸到能出的牌时进入待决定状态，不自动结束回合', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
      drawPile: [num('z', 'red', 9)],
    });
    const next = drawCard(state, 0);
    assert.equal(next.phase, PHASE.DRAWN);
    assert.equal(next.currentPlayer, 0);
    assert.equal(next.drawnCardId, 'z');
  });

  it('摸牌后可以打出刚摸到的那张', () => {
    const state = stateWith({
      hands: [[num('a', 'blue', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
      drawPile: [num('z', 'red', 9)],
    });
    const afterDraw = drawCard(state, 0);
    const next = playCard(afterDraw, 0, 'z', undefined);
    assert.equal(next.currentPlayer, 1);
    assert.equal(next.players[0].hand.length, 1);
  });

  it('摸牌后不能改出别的牌', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
      drawPile: [num('z', 'red', 9)],
    });
    const afterDraw = drawCard(state, 0);
    assert.throws(
      () => playCard(afterDraw, 0, 'a', undefined),
      (err) => err.code === ERROR_CODES.MUST_DECIDE_DRAWN_CARD,
    );
  });

  it('摸牌后可以选择过牌', () => {
    const state = stateWith({
      hands: [[num('a', 'blue', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
      drawPile: [num('z', 'red', 9)],
    });
    const afterDraw = drawCard(state, 0);
    const next = passAfterDraw(afterDraw, 0);
    assert.equal(next.currentPlayer, 1);
    assert.equal(next.phase, PHASE.PLAYING);
  });

  it('同一回合不能摸两次', () => {
    const state = stateWith({
      hands: [[num('a', 'blue', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
      drawPile: [num('z', 'red', 9), num('y', 'red', 1)],
    });
    const afterDraw = drawCard(state, 0);
    assert.throws(
      () => drawCard(afterDraw, 0),
      (err) => err.code === ERROR_CODES.WRONG_PHASE,
    );
  });

  it('摸牌堆用尽时自动洗回弃牌堆', () => {
    const state = stateWith({
      hands: [[num('a', 'blue', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
      drawPile: [],
    });
    // 弃牌堆只有一张桌面牌，无可回收的牌，摸牌失败直接过牌
    const next = drawCard(state, 0);
    assert.equal(next.currentPlayer, 1);
  });
});

/* --------------------------------- 胜负判定 -------------------------------- */

describe('胜负判定', () => {
  it('出完最后一张牌即获胜', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
    });
    const next = playCard(state, 0, 'a', undefined);
    assert.equal(next.phase, PHASE.FINISHED);
    assert.equal(next.winnerId, 'p1');
  });

  it('对局结束后无法继续出牌', () => {
    const state = stateWith({
      hands: [[num('a', 'red', 3)], [num('b', 'blue', 2)]],
      top: num('t', 'red', 7),
    });
    const finished = playCard(state, 0, 'a', undefined);
    assert.throws(
      () => playCard(finished, 1, 'b', undefined),
      (err) => err.code === ERROR_CODES.GAME_FINISHED,
    );
  });
});
