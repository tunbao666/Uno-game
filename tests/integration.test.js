/**
 * 集成测试：让机器人自动对打若干局，验证状态机不会卡死。
 *
 * 只做一件事——把一整局从头打到有人获胜，检查每一步都不抛异常、
 * 牌数守恒、最终能产生赢家。这类测试最容易暴露"某个边界情况下
 * 所有人都不出牌、回合空转"的死循环问题。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE,
  createGame,
  drawCard,
  getPlayableCards,
  getTopCard,
  passAfterDraw,
  playCard,
} from '../shared/rules.js';
import { DECK_SIZE } from '../shared/constants.js';

/** 用最简单的策略打完一局：能出就出第一张可出的牌，否则摸牌再过 */
function playOneGame(seed, playerCount) {
  const names = ['A', 'B', 'C', 'D'].slice(0, playerCount);
  let game = createGame({ players: names.map((name) => ({ name })), seed });

  const initialTotal =
    game.players.reduce((sum, p) => sum + p.hand.length, 0) +
    game.drawPile.length +
    game.discardPile.length;
  assert.equal(initialTotal, DECK_SIZE, `种子 ${seed}：开局牌数不是 108`);

  let steps = 0;
  const maxSteps = 2000;

  while (game.phase !== PHASE.FINISHED && steps < maxSteps) {
    const seat = game.currentPlayer;
    const hand = game.players[seat].hand;
    const ctx = { topCard: getTopCard(game), currentColor: game.currentColor };
    const playable = getPlayableCards(hand, ctx);

    if (playable.length > 0) {
      const card = playable[0];
      game = playCard(game, seat, card.id, card.color ?? 'red');
    } else {
      game = drawCard(game, seat);
      if (game.phase === PHASE.DRAWN) {
        game = passAfterDraw(game, seat);
      }
    }

    const total =
      game.players.reduce((sum, p) => sum + p.hand.length, 0) +
      game.drawPile.length +
      game.discardPile.length;
    assert.equal(total, DECK_SIZE, `种子 ${seed}：第 ${steps} 步后牌数不是 108`);

    steps += 1;
  }

  assert.equal(game.phase, PHASE.FINISHED, `种子 ${seed}：${maxSteps} 步内没有结束，可能死循环`);
  assert.ok(game.winnerId, `种子 ${seed}：结束时没有赢家`);
  assert.equal(
    game.players.find((p) => p.id === game.winnerId).hand.length,
    0,
    `种子 ${seed}：赢家手上还有牌`,
  );

  return steps;
}

describe('整局对弈', () => {
  it('两人局：30 个种子全部正常打完', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      playOneGame(seed, 2);
    }
  });

  it('三人局：30 个种子全部正常打完', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      playOneGame(seed, 3);
    }
  });

  it('四人局：40 个种子全部正常打完', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      playOneGame(seed, 4);
    }
  });

  it('对局长度在合理范围内', () => {
    const steps = playOneGame(2026, 4);
    assert.ok(steps > 5, `对局过短：${steps} 步`);
    assert.ok(steps < 1000, `对局过长：${steps} 步`);
  });
});
