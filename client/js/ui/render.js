/**
 * 界面渲染与交互绑定。
 *
 * 只负责"把状态画出来"和"把点击翻译成事件回调"，
 * 所有规则判定都在 shared/rules.js 里完成，界面不做任何规则推断。
 */

import { COLOR_LABELS } from '../../../shared/constants.js';
import { PHASE, getPlayableCards, getTopCard } from '../../../shared/rules.js';
import { createCardEl, describeCard } from './cards.js';

const els = {
  opponents: document.getElementById('opponents'),
  drawPile: document.getElementById('drawPile'),
  drawCount: document.getElementById('drawCount'),
  discardPile: document.getElementById('discardPile'),
  dirIcon: document.getElementById('dirIcon'),
  colorDot: document.getElementById('colorDot'),
  colorText: document.getElementById('colorText'),
  tableHint: document.getElementById('tableHint'),
  hand: document.getElementById('hand'),
  turnBanner: document.getElementById('turnBanner'),
  handActions: document.getElementById('handActions'),
  logList: document.getElementById('logList'),
};

export function createView({ onPlay, onDraw, onPass, notify }) {
  /** 当前这一帧的上下文，供点击事件使用 */
  const view = {
    state: null,
    humanSeat: 0,
    playable: new Set(),
    isMyTurn: false,
  };

  /** 手牌 DOM 缓存，避免每次渲染都重建导致闪烁 */
  const cardCache = new Map();
  let lastDiscardId = null;
  let lastLogLength = 0;

  /* ------------------------------ 对手席位 ------------------------------ */

  function renderOpponents(state, humanSeat) {
    const fragment = document.createDocumentFragment();

    state.players.forEach((player, index) => {
      if (index === humanSeat) return;

      const seat = document.createElement('div');
      const active = state.currentPlayer === index && state.phase !== PHASE.FINISHED;
      seat.className = active ? 'seat seat--active' : 'seat';

      const initial = player.name.trim().slice(-1);
      const shown = Math.min(player.hand.length, 6);
      const minis = Array.from({ length: shown }, () => '<span class="mini"></span>').join('');
      const more =
        player.hand.length > shown
          ? `<span class="mini mini--more">+${player.hand.length - shown}</span>`
          : '';

      seat.innerHTML = `
        <div class="seat__avatar">${initial}</div>
        <div class="seat__meta">
          <span class="seat__name">${player.name}</span>
          <span class="seat__count">${player.hand.length} 张</span>
        </div>
        <div class="seat__mini">${minis}${more}</div>
      `;

      fragment.appendChild(seat);
    });

    els.opponents.replaceChildren(fragment);
  }

  /* -------------------------------- 牌桌 -------------------------------- */

  function renderDiscard(state) {
    const top = getTopCard(state);
    if (!top) return;
    if (top.id === lastDiscardId) return;

    lastDiscardId = top.id;
    // 只保留最上面一张，以及它下面一张做堆叠层次，避免旧牌从边上露出奇怪的一角
    const recent = state.discardPile.slice(-2);
    els.discardPile.replaceChildren(...recent.map((card) => createCardEl(card)));
  }

  function renderTable(state, humanSeat) {
    els.drawCount.textContent = String(state.drawPile.length);
    els.dirIcon.classList.toggle('is-ccw', state.direction === -1);

    const color = state.currentColor;
    els.colorDot.style.background = `var(--${color})`;
    els.colorText.textContent = `${COLOR_LABELS[color]}色`;

    const myTurn = state.currentPlayer === humanSeat && state.phase !== PHASE.FINISHED;
    els.drawPile.classList.toggle('is-disabled', !myTurn || state.phase !== PHASE.PLAYING);

    if (state.phase === PHASE.FINISHED) {
      els.tableHint.textContent = '对局已结束';
    } else if (!myTurn) {
      els.tableHint.textContent = `等待 ${state.players[state.currentPlayer].name} 出牌`;
    } else if (state.phase === PHASE.DRAWN) {
      els.tableHint.textContent = '可以打出刚摸到的牌，或选择跳过';
    } else if (view.playable.size === 0) {
      els.tableHint.textContent = '没有能出的牌，点摸牌堆摸一张';
    } else {
      els.tableHint.textContent = '选一张高亮的牌打出';
    }
  }

  /* -------------------------------- 手牌 -------------------------------- */

  function fitHand(nodes) {
    const count = nodes.length;
    if (count === 0) return;

    const cardWidth = nodes[0].offsetWidth || 76;
    const available = els.hand.clientWidth - 16;
    nodes[0].style.marginLeft = '0px';
    if (count === 1) return;

    // 空间足够时允许完全展开（step 等于牌宽），牌多时再逐步压缩重叠
    const step = Math.max(
      cardWidth * 0.14,
      Math.min(cardWidth, (available - cardWidth) / (count - 1)),
    );
    const margin = step - cardWidth;
    for (let i = 1; i < count; i += 1) {
      nodes[i].style.marginLeft = `${margin}px`;
    }
  }

  function renderHand(state, humanSeat) {
    const player = state.players[humanSeat];
    const myTurn = state.currentPlayer === humanSeat && state.phase !== PHASE.FINISHED;
    const ctx = { topCard: getTopCard(state), currentColor: state.currentColor };

    let playable = new Set();
    if (myTurn) {
      if (state.phase === PHASE.DRAWN) {
        playable = new Set([state.drawnCardId]);
      } else {
        playable = new Set(getPlayableCards(player.hand, ctx).map((card) => card.id));
      }
    }

    view.playable = playable;
    view.isMyTurn = myTurn;

    const nodes = [];
    const alive = new Set();

    for (const card of player.hand) {
      alive.add(card.id);
      let node = cardCache.get(card.id);
      if (!node) {
        node = createCardEl(card);
        cardCache.set(card.id, node);
      }
      node.classList.toggle('card--playable', myTurn && playable.has(card.id));
      node.classList.toggle('card--dim', myTurn && !playable.has(card.id));
      node.classList.remove('card--hint');
      nodes.push(node);
    }

    for (const [id, node] of cardCache) {
      if (!alive.has(id)) {
        node.remove();
        cardCache.delete(id);
      }
    }

    nodes.forEach((node, index) => {
      if (els.hand.children[index] !== node) {
        els.hand.insertBefore(node, els.hand.children[index] ?? null);
      }
    });

    while (els.hand.children.length > nodes.length) {
      els.hand.lastElementChild.remove();
    }

    fitHand(nodes);
  }

  /* -------------------------------- 状态栏 ------------------------------- */

  function renderStatus(state, humanSeat) {
    const myTurn = state.currentPlayer === humanSeat && state.phase !== PHASE.FINISHED;

    els.handActions.replaceChildren();

    if (state.phase === PHASE.FINISHED) {
      els.turnBanner.textContent = '对局结束';
      return;
    }

    if (!myTurn) {
      els.turnBanner.innerHTML = `<strong>${state.players[state.currentPlayer].name}</strong> 正在出牌…`;
      return;
    }

    if (state.phase === PHASE.DRAWN) {
      const drawn = state.players[humanSeat].hand.find((c) => c.id === state.drawnCardId);
      els.turnBanner.innerHTML = drawn
        ? `摸到 <strong>${describeCard(drawn)}</strong>，可以打出或跳过`
        : '请选择是否打出刚摸到的牌';

      const passBtn = document.createElement('button');
      passBtn.type = 'button';
      passBtn.className = 'btn';
      passBtn.textContent = '跳过本回合';
      passBtn.addEventListener('click', () => onPass());
      els.handActions.appendChild(passBtn);
      return;
    }

    els.turnBanner.innerHTML = '轮到<strong>你</strong>出牌';

    const drawBtn = document.createElement('button');
    drawBtn.type = 'button';
    drawBtn.className = 'btn';
    drawBtn.textContent = '摸一张牌';
    drawBtn.addEventListener('click', () => onDraw());
    els.handActions.appendChild(drawBtn);
  }

  /* -------------------------------- 日志 -------------------------------- */

  function renderLog(state) {
    if (state.log.length < lastLogLength) {
      els.logList.replaceChildren();
      lastLogLength = 0;
    }

    if (state.log.length === lastLogLength) return;

    const items = state.log.slice(lastLogLength);
    lastLogLength = state.log.length;

    const previousLast = els.logList.querySelector('.log__item--last');
    if (previousLast) previousLast.classList.remove('log__item--last');

    for (const text of items) {
      const li = document.createElement('li');
      li.className = 'log__item';
      li.textContent = text;
      els.logList.appendChild(li);
    }

    const last = els.logList.lastElementChild;
    if (last) last.classList.add('log__item--last');

    els.logList.scrollTop = els.logList.scrollHeight;
  }

  /* -------------------------------- 交互 -------------------------------- */

  function shake(node) {
    node.classList.remove('card--shake');
    // 强制重排，让动画能重复触发
    void node.offsetWidth;
    node.classList.add('card--shake');
    setTimeout(() => node.classList.remove('card--shake'), 340);
  }

  els.hand.addEventListener('click', (event) => {
    const node = event.target.closest('.card');
    if (!node) return;

    const state = view.state;
    if (!state || state.phase === PHASE.FINISHED) return;

    if (!view.isMyTurn) {
      notify('还没轮到你出牌');
      return;
    }

    const cardId = node.dataset.cardId;
    const card = state.players[view.humanSeat].hand.find((item) => item.id === cardId);
    if (!card) return;

    if (!view.playable.has(cardId)) {
      shake(node);
      notify(
        state.phase === PHASE.DRAWN
          ? '本回合只能打出刚摸到的那张牌'
          : '这张牌和桌面不匹配',
      );
      return;
    }

    onPlay(card, node);
  });

  els.drawPile.addEventListener('click', () => {
    const state = view.state;
    if (!state || state.phase === PHASE.FINISHED) return;
    if (!view.isMyTurn) {
      notify('还没轮到你');
      return;
    }
    if (state.phase !== PHASE.PLAYING) {
      notify('本回合已经摸过牌了');
      return;
    }
    onDraw();
  });

  /* -------------------------------- 对外 -------------------------------- */

  function render(state, humanSeat) {
    view.state = state;
    view.humanSeat = humanSeat;

    renderOpponents(state, humanSeat);
    renderDiscard(state);
    // 先算手牌，renderTable 需要读 view.playable 来判断提示文案
    renderHand(state, humanSeat);
    renderTable(state, humanSeat);
    renderStatus(state, humanSeat);
    renderLog(state);
  }

  function reset() {
    lastDiscardId = null;
    lastLogLength = 0;
    view.playable = new Set();
    els.discardPile.replaceChildren();
    els.logList.replaceChildren();
    els.handActions.replaceChildren();
  }

  return { render, reset };
}
