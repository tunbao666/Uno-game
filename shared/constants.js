/**
 * 全局常量定义。
 * 前端与服务端共用，任何一处改动都会同时作用于单机模式与联机模式。
 */

/** 四种颜色。顺序会影响牌堆生成顺序，但洗牌后无实际影响。 */
export const COLORS = Object.freeze(['red', 'yellow', 'green', 'blue']);

/** 颜色的中文标签，用于提示文案。 */
export const COLOR_LABELS = Object.freeze({
  red: '红',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
});

/** 牌型。number 为数字牌，其余均为功能牌或万能牌。 */
export const CARD_TYPES = Object.freeze({
  NUMBER: 'number',
  SKIP: 'skip',
  REVERSE: 'reverse',
  DRAW_TWO: 'draw2',
  WILD: 'wild',
  WILD_DRAW_FOUR: 'wild4',
});

/** 需要指定颜色的万能牌类型。 */
export const WILD_TYPES = Object.freeze([
  CARD_TYPES.WILD,
  CARD_TYPES.WILD_DRAW_FOUR,
]);

/** 有颜色限制的功能牌类型，每种颜色各两张。 */
export const ACTIVE_ACTION_TYPES = Object.freeze([
  CARD_TYPES.SKIP,
  CARD_TYPES.REVERSE,
  CARD_TYPES.DRAW_TWO,
]);

/** 牌型的中文名称，用于界面展示与对局日志。 */
export const CARD_LABELS = Object.freeze({
  [CARD_TYPES.SKIP]: '跳过',
  [CARD_TYPES.REVERSE]: '反转',
  [CARD_TYPES.DRAW_TWO]: '抽两张',
  [CARD_TYPES.WILD]: '变色',
  [CARD_TYPES.WILD_DRAW_FOUR]: '变色+4',
});

/** 牌组构成参数，用于生成与校验。 */
export const DECK_SPEC = Object.freeze({
  /** 每色数字 0 的张数 */
  zeroCopies: 1,
  /** 每色数字 1-9 各自的张数 */
  numberCopies: 2,
  /** 每色每种功能牌的张数 */
  actionCopies: 2,
  /** 万能牌（变色）总张数 */
  wildCopies: 4,
  /** 万能牌（变色+4）总张数 */
  wildDrawFourCopies: 4,
});

/** 一副完整牌组的总张数：4×19 + 4×3×2 + 4 + 4 = 108 */
export const DECK_SIZE = 108;

/** 开局每人发牌张数 */
export const CARDS_PER_PLAYER = 7;

/** 支持的玩家数量范围 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
