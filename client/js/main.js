/**
 * 应用入口：串联界面、单机控制器与各类弹窗。
 */

import { CARD_TYPES } from '../../shared/constants.js';
import { PHASE } from '../../shared/rules.js';
import { createLocalGame } from './game/local.js';
import { createView } from './ui/render.js';

const $ = (id) => document.getElementById(id);

const ui = {
  setupModal: $('setupModal'),
  colorModal: $('colorModal'),
  overModal: $('overModal'),
  overKicker: $('overKicker'),
  overTitle: $('overTitle'),
  overText: $('overText'),
  toast: $('toast'),
  logPanel: $('logPanel'),
};

const settings = {
  playerCount: 4,
  difficulty: 'normal',
};

let game = null;
let pendingWildCard = null;
let finishHandled = false;
let toastTimer = null;

/* -------------------------------- 提示 -------------------------------- */

function notify(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-show'), 1800);
}

/* -------------------------------- 视图 -------------------------------- */

const view = createView({
  notify,
  onDraw: () => {
    if (!game) return;
    if (!game.humanDraw()) {
      const state = game.getState();
      if (state && state.phase === PHASE.DRAWN) notify('本回合已经摸过牌了');
    }
  },
  onPass: () => {
    if (game) game.humanPass();
  },
  onPlay: (card) => {
    if (!game) return;

    const needsColor =
      card.type === CARD_TYPES.WILD || card.type === CARD_TYPES.WILD_DRAW_FOUR;

    if (needsColor) {
      pendingWildCard = card;
      ui.colorModal.hidden = false;
      return;
    }

    game.humanPlay(card.id);
  },
});

/* ------------------------------- 开局流程 ------------------------------ */

function startGame() {
  if (game) game.dispose();

  finishHandled = false;
  pendingWildCard = null;
  ui.setupModal.hidden = true;
  ui.overModal.hidden = true;
  ui.colorModal.hidden = true;

  view.reset();

  game = createLocalGame({
    playerCount: settings.playerCount,
    difficulty: settings.difficulty,
    onUpdate: (state) => view.render(state, game.humanSeat),
    onError: (error) => {
      if (error?.message) notify(error.message);
    },
    onFinish: (state) => {
      if (finishHandled) return;
      finishHandled = true;
      showResult(state);
    },
  });

  game.start();
}

function showResult(state) {
  const winner = state.players.find((player) => player.id === state.winnerId);
  const isHumanWin = winner && winner.id === state.players[0].id;

  ui.overKicker.textContent = '对局结束';
  ui.overTitle.textContent = isHumanWin ? '你赢了' : `${winner?.name ?? '对手'} 获胜`;
  ui.overText.textContent = isHumanWin
    ? '漂亮，你第一个出完了手牌。'
    : '再来一局，这次把功能牌留到关键回合试试。';
  ui.overModal.hidden = false;
}

/* -------------------------------- 设置 -------------------------------- */

function bindSegmented(container, key, cast = (value) => value) {
  container.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;

    for (const child of container.children) {
      child.classList.toggle('is-active', child === button);
    }
    settings[key] = cast(button.dataset.value);
  });
}

bindSegmented($('optPlayers'), 'playerCount', Number);
bindSegmented($('optDifficulty'), 'difficulty');

$('btnStart').addEventListener('click', startGame);
$('btnRestart').addEventListener('click', () => startGame());
$('btnAgain').addEventListener('click', () => startGame());
$('btnBackHome').addEventListener('click', () => {
  if (game) game.dispose();
  game = null;
  ui.overModal.hidden = true;
  ui.setupModal.hidden = false;
});

/* -------------------------------- 选色 -------------------------------- */

$('colorGrid').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-color]');
  if (!button || !pendingWildCard || !game) return;

  const color = button.dataset.color;
  const card = pendingWildCard;
  pendingWildCard = null;
  ui.colorModal.hidden = true;
  game.humanPlay(card.id, color);
});

$('btnCancelColor').addEventListener('click', () => {
  pendingWildCard = null;
  ui.colorModal.hidden = true;
});

/* -------------------------------- 日志 -------------------------------- */

$('btnLog').addEventListener('click', () => ui.logPanel.classList.toggle('is-open'));
$('btnLogClose').addEventListener('click', () => ui.logPanel.classList.remove('is-open'));

/* ------------------------------ 窗口尺寸 ------------------------------ */

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (game && game.getState()) view.render(game.getState(), game.humanSeat);
  }, 120);
});

/* ------------------------------ 快捷键 ------------------------------ */

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!ui.colorModal.hidden) {
      pendingWildCard = null;
      ui.colorModal.hidden = true;
    }
    ui.logPanel.classList.remove('is-open');
  }
});
