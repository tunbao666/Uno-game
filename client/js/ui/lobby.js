/**
 * 等待室渲染。
 *
 * 只负责把服务端下发的房间信息画出来，并在房主视角下给出"踢人"按钮。
 * 谁能踢、什么时候能踢，服务端都会再校验一次，这里只是提前把不可用的操作藏掉。
 */

const SEAT_TOTAL = 4;

/**
 * @param {HTMLElement} container 座位列表容器
 * @param {object} room 房间信息 { code, hostSeat, started, players: [{seat, name, connected, isHost}] }
 * @param {{mySeat: number, onKick: (seat: number) => void}} options
 */
export function renderLobby(container, room, { mySeat, onKick }) {
  const players = [...(room.players ?? [])].sort((a, b) => a.seat - b.seat);
  const bySeat = new Map(players.map((player) => [player.seat, player]));
  const iAmHost = room.hostSeat === mySeat;

  const fragment = document.createDocumentFragment();

  for (let seat = 0; seat < SEAT_TOTAL; seat += 1) {
    const player = bySeat.get(seat);
    const row = document.createElement('li');
    row.className = 'lobby-seat';
    if (!player) row.classList.add('lobby-seat--empty');
    if (player?.seat === mySeat) row.classList.add('lobby-seat--me');

    const index = document.createElement('span');
    index.className = 'lobby-seat__index';
    index.textContent = String(seat + 1);

    const name = document.createElement('span');
    name.className = 'lobby-seat__name';
    name.textContent = player ? player.name : '等待加入…';

    row.append(index, name);

    if (player?.isHost) {
      const badge = document.createElement('span');
      badge.className = 'lobby-seat__badge';
      badge.textContent = '房主';
      row.append(badge);
    }

    if (player && !player.connected) {
      const state = document.createElement('span');
      state.className = 'lobby-seat__offline';
      state.textContent = '掉线';
      row.append(state);
    }

    // 房主可以踢掉其他人，但不能踢自己
    if (player && iAmHost && player.seat !== mySeat) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'lobby-seat__kick';
      kick.textContent = '移出';
      kick.addEventListener('click', () => onKick?.(player.seat));
      row.append(kick);
    }

    fragment.append(row);
  }

  container.replaceChildren(fragment);
}

/**
 * 等待室的提示文案与按钮状态。
 * @returns {{canStart: boolean, hint: string, iAmHost: boolean}}
 */
export function lobbyState(room, mySeat) {
  const players = room?.players ?? [];
  const iAmHost = room?.hostSeat === mySeat;
  const enough = players.length >= 2;

  let hint;
  if (!enough) hint = '至少需要 2 名玩家才能开始，把房间码发给朋友吧。';
  else if (iAmHost) hint = '人齐了就可以开始，也可以再多等一位朋友。';
  else hint = '等待房主开始游戏…';

  return { canStart: iAmHost && enough, hint, iAmHost };
}
