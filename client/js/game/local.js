/**
 * 单机对局控制器。
 *
 * 负责：开局、驱动 AI 回合、把玩家的点击翻译成规则引擎调用。
 * 所有规则判定都委托给 shared/rules.js，这一层不含任何规则逻辑。
 */

import {
  PHASE,
  createGame,
  drawCard,
  passAfterDraw,
  playCard,
} from '../../../shared/rules.js';
import { DIFFICULTY, chooseMove } from '../ai/ai.js';

const AI_NAMES = ['电脑 A', '电脑 B', '电脑 C'];
const HUMAN_SEAT = 0;

export function createLocalGame({
  playerCount = 4,
  difficulty = DIFFICULTY.NORMAL,
  onUpdate,
  onFinish,
  onError,
} = {}) {
  let state = null;
  let timer = null;
  let token = 0;
  let disposed = false;

  function emit() {
    if (state) onUpdate?.(state);
  }

  /** 轮到 AI 时排一个带思考延迟的定时任务 */
  function tick() {
    if (disposed || !state) return;

    if (state.phase === PHASE.FINISHED) {
      onFinish?.(state);
      return;
    }

    if (!state.players[state.currentPlayer].isAI) return;

    const current = ++token;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (disposed || current !== token) return;
      aiStep();
    }, 700 + Math.random() * 500);
  }

  function aiStep() {
    if (!state || state.phase === PHASE.FINISHED) return;

    const seat = state.currentPlayer;
    const move = chooseMove(state, difficulty);

    try {
      if (move.action === 'play') {
        state = playCard(state, seat, move.cardId, move.color);
      } else if (move.action === 'draw') {
        state = drawCard(state, seat);
      } else if (move.action === 'pass') {
        state = passAfterDraw(state, seat);
      }
    } catch (error) {
      onError?.(error);
      // 兜底：AI 决策异常时退回摸牌 / 过牌，绝不让牌局卡死
      try {
        state = drawCard(state, seat);
      } catch {
        try {
          state = passAfterDraw(state, seat);
        } catch {
          /* 实在无法推进，保持现状等待下一帧 */
        }
      }
    }

    emit();
    tick();
  }

  function isHumanTurn() {
    return Boolean(state) && state.currentPlayer === HUMAN_SEAT && state.phase !== PHASE.FINISHED;
  }

  function start() {
    disposed = false;
    clearTimeout(timer);

    const players = [{ name: '你' }];
    for (let index = 1; index < playerCount; index += 1) {
      players.push({ name: AI_NAMES[index - 1] ?? `电脑 ${index}`, isAI: true });
    }

    state = createGame({ players });
    emit();
    tick();
  }

  function humanPlay(cardId, color) {
    if (!isHumanTurn()) return false;
    try {
      state = playCard(state, HUMAN_SEAT, cardId, color);
    } catch (error) {
      onError?.(error);
      return false;
    }
    emit();
    tick();
    return true;
  }

  function humanDraw() {
    if (!isHumanTurn() || state.phase !== PHASE.PLAYING) return false;
    try {
      state = drawCard(state, HUMAN_SEAT);
    } catch (error) {
      onError?.(error);
      return false;
    }
    emit();
    tick();
    return true;
  }

  function humanPass() {
    if (!isHumanTurn() || state.phase !== PHASE.DRAWN) return false;
    try {
      state = passAfterDraw(state, HUMAN_SEAT);
    } catch (error) {
      onError?.(error);
      return false;
    }
    emit();
    tick();
    return true;
  }

  function dispose() {
    disposed = true;
    clearTimeout(timer);
    state = null;
  }

  return {
    start,
    humanPlay,
    humanDraw,
    humanPass,
    dispose,
    getState: () => state,
    humanSeat: HUMAN_SEAT,
  };
}
