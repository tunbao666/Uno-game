/**
 * 应用入口：串联界面、单机控制器、联机会话与各类弹窗。
 *
 * 单机与联机对外暴露同一套接口（humanPlay / humanDraw / humanPass / getState / humanSeat），
 * 因此界面渲染、出牌交互、结算弹窗三处逻辑完全共用，只有"谁来裁判"不同：
 * 单机是本地规则引擎，联机是服务端。
 */

import { CARD_TYPES } from '../../shared/constants.js';
import { PHASE } from '../../shared/rules.js';
import { createLocalGame } from './game/local.js';
import { createOnlineGame, hasSavedSession } from './game/online.js';
import { createView } from './ui/render.js';
import { lobbyState, renderLobby } from './ui/lobby.js';
import { mountRules, syncRulesFade } from './ui/rules.js';

const $ = (id) => document.getElementById(id);

const NAME_KEY = 'uno.name.v1';

const ui = {
  setupModal: $('setupModal'),
  colorModal: $('colorModal'),
  overModal: $('overModal'),
  overKicker: $('overKicker'),
  overTitle: $('overTitle'),
  overText: $('overText'),
  rulesModal: $('rulesModal'),
  rulesBody: $('rulesBody'),
  toast: $('toast'),
  logPanel: $('logPanel'),

  localOptions: $('localOptions'),
  onlineOptions: $('onlineOptions'),
  inputName: $('inputName'),
  inputCode: $('inputCode'),

  brandSub: $('brandSub'),
  roomChip: $('roomChip'),
  roomChipCode: $('roomChipCode'),
  btnRestart: $('btnRestart'),
  btnLeaveRoom: $('btnLeaveRoom'),
  btnPhrases: $('btnPhrases'),
  btnAgain: $('btnAgain'),
  btnBackHome: $('btnBackHome'),

  lobbyModal: $('lobbyModal'),
  lobbyCode: $('lobbyCode'),
  lobbySeats: $('lobbySeats'),
  lobbyHint: $('lobbyHint'),
  btnLobbyStart: $('btnLobbyStart'),
  btnLobbyLeave: $('btnLobbyLeave'),

  netbar: $('netbar'),
  netbarText: $('netbarText'),
  feed: $('feed'),
  phrases: $('phrases'),
  phrasesGrid: $('phrasesGrid'),
};

const settings = {
  mode: 'local',
  playerCount: 4,
  difficulty: 'normal',
};

/** 当前对局：单机控制器或联机会话，接口一致 */
let game = null;
/** 联机会话（含等待室阶段），与 game 指向同一对象 */
let online = null;
/** 我在房间里的座位号（房间席位，不是牌局内序号） */
let roomSeat = 0;

let pendingWildCard = null;
let finishHandled = false;
let toastTimer = null;

/* -------------------------------- 提示 -------------------------------- */

function notify(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-show'), 2200);
}

/* ------------------------------ 规则说明 ------------------------------ */

const rules = {
  open() {
    mountRules(ui.rulesBody);
    ui.rulesModal.hidden = false;
    requestAnimationFrame(() => syncRulesFade(ui.rulesBody));
  },
  close() {
    ui.rulesModal.hidden = true;
  },
  get isOpen() {
    return !ui.rulesModal.hidden;
  },
};

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

/* ------------------------------ 单机流程 ------------------------------ */

function startLocalGame() {
  if (online) leaveOnline({ silent: true });
  if (game) game.dispose();

  finishHandled = false;
  pendingWildCard = null;
  ui.setupModal.hidden = true;
  ui.overModal.hidden = true;
  ui.colorModal.hidden = true;
  ui.rulesModal.hidden = true;
  ui.lobbyModal.hidden = true;

  setModeChrome('local');
  setStageIdle(false);
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

/* ------------------------------ 联机流程 ------------------------------ */

function ensureOnline() {
  if (online) return online;

  online = createOnlineGame({
    onJoined: (payload) => {
      roomSeat = payload.seat;
      game = online;
      ui.setupModal.hidden = true;
      ui.lobbyCode.textContent = payload.code;
      ui.roomChipCode.textContent = payload.code;

      if (payload.started) {
        enterGameChrome();
      } else {
        enterLobbyChrome();
        ui.lobbyModal.hidden = false;
      }
      updateLobby({
        code: payload.code,
        hostSeat: payload.hostSeat,
        started: payload.started,
        players: payload.players,
      });
    },

    onRoom: (room) => {
      updateLobby(room);
      if (room.started) {
        ui.lobbyModal.hidden = true;
        enterGameChrome();
      } else {
        enterLobbyChrome();
        ui.lobbyModal.hidden = false;
      }
    },

    onState: (state, seat) => {
      game = online;
      finishHandled = false;
      enterGameChrome();
      ui.lobbyModal.hidden = true;
      view.render(state, seat);
    },

    onFinish: (state) => showResult(state),

    onNotice: (text) => notify(text),

    onSay: (message) => pushFeed(message.name, message.text),

    onError: (text) => {
      notify(text);
      if (/房间已关闭|座位已被释放/.test(text)) {
        leaveOnline({ silent: true });
      }
    },

    onKicked: (reason) => {
      leaveOnline({ silent: true });
      notify(reason);
    },

    onStatus: (status, attempt) => {
      if (status === 'online') {
        setNetbar(null);
      } else if (status === 'connecting') {
        setNetbar('正在连接服务器…');
      } else if (status === 'reconnecting') {
        setNetbar(`连接中断，正在重连（第 ${attempt} 次）…`);
      } else if (status === 'lost') {
        setNetbar(null);
        leaveOnline({ silent: true });
        notify('连接已断开，请重新进入房间');
      }
    },
  });

  return online;
}

function updateLobby(room) {
  if (!room) return;
  ui.lobbyCode.textContent = room.code;
  ui.roomChipCode.textContent = room.code;
  ui.roomChip.hidden = false;

  renderLobby(ui.lobbySeats, room, {
    mySeat: roomSeat,
    onKick: (seat) => online?.kick(seat),
  });

  const info = lobbyState(room, roomSeat);
  ui.lobbyHint.textContent = info.hint;
  ui.btnLobbyStart.hidden = !info.iAmHost;
  ui.btnLobbyStart.disabled = !info.canStart;
}

/** 进入牌桌时的顶栏形态 */
function enterGameChrome() {
  setStageIdle(false);
  ui.brandSub.textContent = '联机对战';
  ui.roomChip.hidden = false;
  ui.btnPhrases.hidden = false;
  ui.btnRestart.hidden = true;
  ui.btnLeaveRoom.hidden = false;
}

/** 等待室：还没有牌桌可看，只保留房间相关操作 */
function enterLobbyChrome() {
  setStageIdle(true);
  ui.brandSub.textContent = '联机对战';
  ui.roomChip.hidden = false;
  ui.btnPhrases.hidden = true;
  ui.btnRestart.hidden = true;
  ui.btnLeaveRoom.hidden = false;
}

/** 没在牌局里时把空牌桌藏起来，避免弹窗背后露出一张空桌子 */
function setStageIdle(idle) {
  document.body.classList.toggle('is-idle', idle);
}

function setModeChrome(mode) {
  if (mode === 'online') {
    enterLobbyChrome();
  } else {
    setStageIdle(true);
    ui.brandSub.textContent = '单机 · 人机对战';
    ui.roomChip.hidden = true;
    ui.btnPhrases.hidden = true;
    ui.btnRestart.hidden = false;
    ui.btnLeaveRoom.hidden = true;
    ui.phrases.hidden = true;
  }
}

function leaveOnline({ silent = false } = {}) {
  online?.leave();
  online?.dispose();
  online = null;
  game = null;
  view.reset();

  ui.overModal.hidden = true;
  ui.lobbyModal.hidden = true;
  ui.phrases.hidden = true;
  ui.setupModal.hidden = false;
  ui.feed.replaceChildren();
  setNetbar(null);
  setModeChrome('local');

  if (!silent) notify('已离开房间');
}

/* ------------------------------ 结算弹窗 ------------------------------ */

function showResult(state) {
  const mySeat = game?.humanSeat ?? 0;
  const winner = state.players.find((player) => player.id === state.winnerId);
  const isHumanWin = Boolean(winner) && winner.id === state.players[mySeat]?.id;

  ui.overKicker.textContent = '对局结束';
  ui.overTitle.textContent = isHumanWin ? '你赢了' : `${winner?.name ?? '对手'} 获胜`;

  if (settings.mode === 'online' || online) {
    const room = online?.getRoom();
    const isHost = room?.hostSeat === roomSeat;

    ui.overText.textContent = isHumanWin
      ? '漂亮，你第一个出完了手牌。'
      : isHost
        ? '你可以直接开下一局，他们会在原座位继续。'
        : '等待房主开下一局，或者先离开房间。';

    ui.btnAgain.textContent = isHost ? '再来一局' : '等待房主开下一局';
    ui.btnAgain.disabled = !isHost;
    ui.btnBackHome.textContent = '离开房间';
  } else {
    ui.overText.textContent = isHumanWin
      ? '漂亮，你第一个出完了手牌。'
      : '再来一局，这次把功能牌留到关键回合试试。';
    ui.btnAgain.textContent = '再来一局';
    ui.btnAgain.disabled = false;
    ui.btnBackHome.textContent = '返回设置';
  }

  ui.overModal.hidden = false;
}

/* ------------------------------ 昵称读写 ------------------------------ */

function readName() {
  const value = ui.inputName.value.trim();
  return value || '';
}

function loadName() {
  try {
    ui.inputName.value = localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    /* 忽略 */
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------ 连接状态条 ----------------------------- */

function setNetbar(text) {
  if (!text) {
    ui.netbar.hidden = true;
    return;
  }
  ui.netbarText.textContent = text;
  ui.netbar.hidden = false;
}

/* ------------------------------ 快捷短语 ------------------------------ */

const PHRASES = ['快点啊', '好牌！', '手下留情', '这把算你狠', '再来一局？', '我先走了'];

function buildPhrases() {
  if (ui.phrasesGrid.dataset.ready === '1') return;
  for (const text of PHRASES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', () => {
      online?.say(text);
      ui.phrases.hidden = true;
    });
    ui.phrasesGrid.append(button);
  }
  ui.phrasesGrid.dataset.ready = '1';
}

function pushFeed(name, text) {
  const item = document.createElement('div');
  item.className = 'feed__item';

  const who = document.createElement('b');
  who.textContent = name;
  item.append(who, document.createTextNode(text));

  ui.feed.append(item);
  while (ui.feed.children.length > 4) ui.feed.firstElementChild.remove();

  setTimeout(() => {
    item.classList.add('is-out');
    setTimeout(() => item.remove(), 450);
  }, 5200);
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

$('optMode').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button) return;

  for (const child of $('optMode').children) {
    child.classList.toggle('is-active', child === button);
  }

  settings.mode = button.dataset.value;
  ui.localOptions.hidden = settings.mode !== 'local';
  ui.onlineOptions.hidden = settings.mode !== 'online';
});

$('btnStart').addEventListener('click', startLocalGame);
$('btnRestart').addEventListener('click', startLocalGame);

$('btnCreateRoom').addEventListener('click', () => {
  const name = readName();
  if (!name) {
    notify('先起个昵称吧');
    ui.inputName.focus();
    return;
  }
  saveName(name);
  ensureOnline().createRoom(name);
});

$('btnJoinRoom').addEventListener('click', () => {
  const name = readName();
  if (!name) {
    notify('先起个昵称吧');
    ui.inputName.focus();
    return;
  }
  const code = ui.inputCode.value.trim();
  if (!/^\d{4}$/.test(code)) {
    notify('房间码是 4 位数字');
    ui.inputCode.focus();
    return;
  }
  saveName(name);
  ensureOnline().joinRoom(code, name);
});

ui.inputCode.addEventListener('input', () => {
  ui.inputCode.value = ui.inputCode.value.replace(/\D/g, '').slice(0, 4);
});

ui.btnLobbyStart.addEventListener('click', () => online?.start());
ui.btnLobbyLeave.addEventListener('click', () => leaveOnline());
ui.btnLeaveRoom.addEventListener('click', () => leaveOnline());

ui.btnPhrases.addEventListener('click', () => {
  buildPhrases();
  ui.phrases.hidden = !ui.phrases.hidden;
});
$('btnPhrasesClose').addEventListener('click', () => {
  ui.phrases.hidden = true;
});

$('btnAgain').addEventListener('click', () => {
  if (online) {
    ui.overModal.hidden = true;
    online.again();
    return;
  }
  startLocalGame();
});

ui.btnBackHome.addEventListener('click', () => {
  ui.overModal.hidden = true;
  if (online) {
    leaveOnline();
    return;
  }
  if (game) game.dispose();
  game = null;
  setStageIdle(true);
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

/* ------------------------------ 规则说明 ------------------------------ */

$('btnRules').addEventListener('click', () => rules.open());
$('btnRulesSetup').addEventListener('click', () => rules.open());
$('btnRulesClose').addEventListener('click', () => rules.close());
$('btnRulesOk').addEventListener('click', () => rules.close());

ui.rulesModal.addEventListener('click', (event) => {
  if (event.target === ui.rulesModal) rules.close();
});

/* -------------------------------- 日志 -------------------------------- */

$('btnLog').addEventListener('click', () => ui.logPanel.classList.toggle('is-open'));
$('btnLogClose').addEventListener('click', () => ui.logPanel.classList.remove('is-open'));

/* ------------------------------ 窗口尺寸 ------------------------------ */

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const state = game?.getState();
    if (state) view.render(state, game.humanSeat);
  }, 120);
});

/* ------------------------------ 快捷键 ------------------------------ */

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;

  if (!ui.phrases.hidden) {
    ui.phrases.hidden = true;
    return;
  }
  if (rules.isOpen) {
    rules.close();
    return;
  }
  if (!ui.colorModal.hidden) {
    pendingWildCard = null;
    ui.colorModal.hidden = true;
  }
  ui.logPanel.classList.remove('is-open');
});

/* ------------------------------ 启动 ------------------------------ */

loadName();
setModeChrome('local');

// 上次还有没打完的房间就自动回去，避免刷新页面丢局
if (hasSavedSession()) {
  setNetbar('正在恢复上次的房间…');
  ensureOnline().resume('');
}
