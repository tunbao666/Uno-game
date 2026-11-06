/**
 * 联机时的视野投影。
 *
 * 服务端持有完整牌局，但发给每个玩家之前必须裁剪：
 * - 别人的手牌只给张数，绝不把牌对象发出去（否则打开控制台就能看穿全场）
 * - 摸牌堆只给剩余数量，不给牌序（否则可以算出每一摸是什么）
 * - 随机种子不下发（否则能复现整副牌序）
 *
 * 裁剪后的结构与本地牌局高度相似，界面层因此不需要区分单机/联机。
 */

/** 弃牌堆只保留最近几张，够渲染层次即可 */
export const PUBLIC_DISCARD_KEEP = 3;

/** 日志只保留最近的若干条，避免长局状态包无限变大 */
export const LOG_KEEP = 60;

/**
 * 把权威状态投影成某个座位能看到的版本。
 * @param {object} state 完整牌局状态
 * @param {number} seat 接收者在这局游戏里的座位号
 * @param {{abandoned?: boolean}[]} [extras] 与 players 同序的附加信息（如是否托管）
 */
export function projectState(state, seat, extras = []) {
  return {
    players: state.players.map((player, index) => {
      const base = {
        id: player.id,
        name: player.name,
        handCount: player.hand.length,
        abandoned: Boolean(extras[index]?.abandoned),
      };
      return index === seat ? { ...base, hand: player.hand } : base;
    }),
    drawCount: state.drawPile.length,
    discardPile: state.discardPile.slice(-PUBLIC_DISCARD_KEEP),
    currentColor: state.currentColor,
    direction: state.direction,
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    drawnCardId: state.drawnCardId,
    winnerId: state.winnerId,
    turnCount: state.turnCount,
    log: state.log.slice(-LOG_KEEP),
  };
}

/** 大厅里展示的玩家信息，同样不包含任何牌面 */
export function projectPlayer(player) {
  return {
    seat: player.seat,
    name: player.name,
    connected: player.connected,
    abandoned: Boolean(player.abandoned),
    isHost: Boolean(player.isHost),
  };
}
