/**
 * 卡牌 DOM 构建。
 * 全部用 CSS + 内联 SVG 绘制，不依赖任何图片或字体图标，
 * 因此离线可用、任意分辨率下都清晰。
 */

import { CARD_LABELS, CARD_TYPES, COLOR_LABELS } from '../../../shared/constants.js';

/** 跳过 / 反转 用内联 SVG 绘制，避免依赖特殊字符在不同字体下的显示差异 */
const SYMBOLS = {
  [CARD_TYPES.SKIP]: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3"/>
    <line x1="5.8" y1="18.2" x2="18.2" y2="5.8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
  </svg>`,
  [CARD_TYPES.REVERSE]: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 8.5h12"/>
      <path d="M12.5 4.5 16.5 8.5 12.5 12.5"/>
      <path d="M20 15.5H8"/>
      <path d="M11.5 11.5 7.5 15.5 11.5 19.5"/>
    </g>
  </svg>`,
};

/** 牌面简短文字：角标用 */
function cornerLabel(card) {
  if (card.type === CARD_TYPES.NUMBER) return String(card.value);
  if (card.type === CARD_TYPES.DRAW_TWO) return '+2';
  if (card.type === CARD_TYPES.WILD_DRAW_FOUR) return '+4';
  return '';
}

/** 屏幕阅读器与 tooltip 用的完整描述 */
export function describeCard(card) {
  if (card.type === CARD_TYPES.NUMBER) {
    return `${COLOR_LABELS[card.color]}色 ${card.value}`;
  }
  if (card.type === CARD_TYPES.WILD || card.type === CARD_TYPES.WILD_DRAW_FOUR) {
    return `万能牌 ${CARD_LABELS[card.type]}`;
  }
  return `${COLOR_LABELS[card.color]}色 ${CARD_LABELS[card.type]}`;
}

/** 中央白色椭圆内的内容 */
function ovalContent(card) {
  if (card.type === CARD_TYPES.NUMBER) {
    return `<span class="card__mark">${card.value}</span>`;
  }
  if (card.type === CARD_TYPES.DRAW_TWO) {
    return `<span class="card__mark">+2</span>`;
  }
  if (SYMBOLS[card.type]) {
    return `<span class="card__mark">${SYMBOLS[card.type]}</span>`;
  }
  return '';
}

/**
 * 创建一张牌的 DOM 元素。
 * @param {object} card 牌面数据
 * @returns {HTMLElement}
 */
export function createCardEl(card) {
  const el = document.createElement('div');
  el.className = `card card--${card.color ?? 'wild'}`;
  el.dataset.cardId = card.id;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', describeCard(card));
  el.title = describeCard(card);

  const corner = cornerLabel(card);
  const isWild =
    card.type === CARD_TYPES.WILD || card.type === CARD_TYPES.WILD_DRAW_FOUR;

  if (isWild) {
    const four =
      card.type === CARD_TYPES.WILD_DRAW_FOUR
        ? '<span class="card__four">+4</span>'
        : '';
    el.innerHTML = `<span class="card__oval card__oval--wild"><i></i><i></i><i></i><i></i></span>${four}`;
  } else {
    el.innerHTML = `
      <span class="card__corner card__corner--tl">${corner}</span>
      <span class="card__corner card__corner--br">${corner}</span>
      <span class="card__oval">${ovalContent(card)}</span>
    `;
  }

  return el;
}

/** 创建一张牌背 */
export function createBackEl() {
  const el = document.createElement('div');
  el.className = 'card card--back';
  el.setAttribute('aria-hidden', 'true');
  return el;
}
