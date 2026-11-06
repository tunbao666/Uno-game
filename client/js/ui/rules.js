/**
 * 规则说明面板的内容构建。
 *
 * 牌型行里的卡面直接复用 createCardEl 生成，
 * 保证"说明里画的牌"与"牌桌上真实出现的牌"永远一致，
 * 不会出现改了卡面样式而说明图忘记同步的问题。
 */

import { CARD_TYPES } from '../../../shared/constants.js';
import { createCardEl } from './cards.js';

/** 牌型一览：每行一张真实卡面 + 名称 + 张数 + 作用 */
const CARD_ROWS = [
  {
    card: { id: 'rule-number', color: 'red', type: CARD_TYPES.NUMBER, value: 7 },
    name: '数字牌 0–9',
    count: '每色 19 张',
    desc: '0 每色 1 张，1–9 各 2 张。出牌需与桌面牌同色，或数字相同。',
  },
  {
    card: { id: 'rule-skip', color: 'green', type: CARD_TYPES.SKIP, value: null },
    name: '跳过 Skip',
    count: '每色 2 张',
    desc: '下一位玩家失去这一回合，直接轮到他后面的人。',
  },
  {
    card: { id: 'rule-reverse', color: 'blue', type: CARD_TYPES.REVERSE, value: null },
    name: '反转 Reverse',
    count: '每色 2 张',
    desc: '出牌方向倒转。两人对局时效果等同于「跳过」，你会再出一次。',
  },
  {
    card: { id: 'rule-draw2', color: 'yellow', type: CARD_TYPES.DRAW_TWO, value: null },
    name: '抽两张 +2',
    count: '每色 2 张',
    desc: '下一位玩家摸 2 张牌，并失去这一回合。不能再用 +2 顶回去。',
  },
  {
    card: { id: 'rule-wild', color: null, type: CARD_TYPES.WILD, value: null },
    name: '变色 Wild',
    count: '共 4 张',
    desc: '任何时候都能出。由你指定接下来是红、黄、绿、蓝中的哪一种，下一位玩家照常出牌。',
  },
  {
    card: { id: 'rule-wild4', color: null, type: CARD_TYPES.WILD_DRAW_FOUR, value: null },
    name: '变色 +4',
    count: '共 4 张',
    desc: '指定颜色，下一位玩家摸 4 张并失去回合。手上还有当前颜色的牌时不能用，这张牌会变灰、点不动。',
  },
];

const STEPS = [
  '打出一张与桌面牌**同色、同数字或同符号**的牌。',
  '没有能打的牌时，点左侧的摸牌堆摸一张。摸到的牌如果能打，你可以选择立刻打出，也可以留着直接结束回合。',
  '打出功能牌后效果立刻结算，然后轮到下一位玩家。',
  '谁先出完手上的牌，谁就获胜。一局定胜负。',
];

const NOTES = [
  '**起始牌一定是数字牌**：如果翻开的功能牌或万能牌，会压回牌堆重新翻一张。',
  '**不叠牌**：+2 就是摸 2 张，不能再用 +2 或 +4 叠加反弹。',
  '**不质疑 +4**：不用弹窗问你信不信，界面上直接禁止不合规打出。',
  '**不用喊 UNO**：剩最后一张时不必点按钮宣告，也不会被罚牌。',
  '**不计分**：不做 500 分多轮赛，出完即赢。',
];

const TIPS = [
  '能打的牌会向上浮起、加深阴影；不能打的牌会变灰且点不动。',
  '点击浮起的牌即出牌。打出万能牌会弹出四色面板，选完颜色才真正生效。',
  '轮到你却无牌可出时，点左边的摸牌堆摸牌。',
  '右上角「对局日志」能看到每一步谁打了什么牌。',
];

/** 把 **加粗** 标记转成 <strong>，其余文本按纯文本处理 */
function withStrong(text) {
  const frag = document.createDocumentFragment();
  text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (!part) return;
    if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      frag.append(strong);
    } else {
      frag.append(document.createTextNode(part));
    }
  });
  return frag;
}

function buildSection(title) {
  const section = document.createElement('section');
  section.className = 'rules__section';

  const heading = document.createElement('h3');
  heading.className = 'rules__h3';
  heading.textContent = title;
  section.append(heading);

  return section;
}

function buildCardRows() {
  const section = buildSection('牌型一览');

  for (const row of CARD_ROWS) {
    const item = document.createElement('div');
    item.className = 'rules__row';

    const mini = document.createElement('div');
    mini.className = 'rules__mini';
    mini.append(createCardEl(row.card));

    const text = document.createElement('div');
    text.className = 'rules__text';

    const head = document.createElement('div');
    head.className = 'rules__name';
    head.textContent = row.name;

    const badge = document.createElement('span');
    badge.className = 'rules__count';
    badge.textContent = row.count;
    head.append(badge);

    const desc = document.createElement('p');
    desc.className = 'rules__desc';
    desc.textContent = row.desc;

    text.append(head, desc);
    item.append(mini, text);
    section.append(item);
  }

  return section;
}

function buildSteps() {
  const section = buildSection('每回合怎么做');
  const list = document.createElement('ol');
  list.className = 'rules__steps';

  STEPS.forEach((step) => {
    const li = document.createElement('li');
    li.append(withStrong(step));
    list.append(li);
  });

  section.append(list);
  return section;
}

function buildNotes(title, items) {
  const section = buildSection(title);
  const list = document.createElement('ul');
  list.className = 'rules__notes';

  items.forEach((item) => {
    const li = document.createElement('li');
    li.append(withStrong(item));
    list.append(li);
  });

  section.append(list);
  return section;
}

/**
 * 内容超出可视区时给底部加一层渐隐，提示"还能继续往下滚"。
 * 滚到底后自动去掉，避免最后一行被淡化。
 * @param {HTMLElement} root 滚动容器
 */
export function syncRulesFade(root) {
  if (!root || root.hidden) return;
  const more = root.scrollHeight - root.scrollTop - root.clientHeight > 4;
  root.classList.toggle('has-more', more);
}

/**
 * 把完整的规则说明渲染进指定容器（只渲染一次）。
 * @param {HTMLElement} root 容器
 */
export function mountRules(root) {
  if (root.dataset.ready !== '1') {
    const goal = buildSection('目标');
    const goalText = document.createElement('p');
    goalText.className = 'rules__lead';
    goalText.textContent =
      '每人发 7 张牌，桌上先翻开一张作为起始牌。轮到你时打出一张能接上的牌，先把手牌出完的人获胜。';
    goal.append(goalText);

    root.append(
      goal,
      buildSteps(),
      buildCardRows(),
      buildNotes('这一版的精简规则', NOTES),
      buildNotes('操作提示', TIPS),
    );

    root.dataset.ready = '1';
    root.addEventListener('scroll', () => syncRulesFade(root), { passive: true });
    window.addEventListener('resize', () => syncRulesFade(root));
  }

  syncRulesFade(root);
}
