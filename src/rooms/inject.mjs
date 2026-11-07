// R12 inject —— 记忆卡（M3 影子模式：只记录「本来会注入什么」，不注入）
//
// 契约：docs/数据契约.md §7.3、方案.md §7.2/§7.3、docs/记忆的职责边界.md §1/§2/§4/§5。
// 三条铁律（本文件里逐条对应，审查在 R13 gates）：
//   1) 只陈述事实：渲染行没有祈使句 / 下一步 / 许可 / 建议。R12 只给模板；拦截在 R13 边界闸。
//   2) 每条带 provenance（episode + seq）与 occurredAt，日期渲染成绝对日期（UTC，跨机可复算）。
//      缺 occurredAt / 缺 seq ⇒ **不入卡**（无源不入、无时不入），只计入省略。
//   3) shadow：只把 {card, signal, at} 追加进 `evidence/shadow/shadow.jsonl`（或 --shadow-dir），
//      **不写 <DSH_HOME>**（本文件对此有硬守卫）、不碰系统提示词 / AGENTS / 工具 / 会话日志。
//
// 本房间是纯函数 + 一个追加写：不调用模型、不做语义判断、不新增依赖（只用 node: 内置）。
// 卡片形态（Q7 = D：首轮一行 INDEX 指针 + 命中才展开）：
//   indexLine 恒一行：`MEMORY: <index 路径>（scope=…, N 局, 未列出≠不存在）`
//   section   仅当命中：<memory-ledger> 内每行 `- [state] 文本 (ep-…, YYYY-MM-DD, seq N)`，≤5 条、≤500 tokens
//   排序      失败教训 → 约束/偏好 → 事实 → 定式候选（同档按 occurredAt 新→旧）
//   三级交付（T3）：
//     content  —— 有把握：给全文（逐字原文 + 坐标）；
//     pointers —— 没把握：只给指针（`episode + seq + occurredAt`），正文不渲染；
//     abstain  —— 无关 / 无源 / 预算放不下：零展开（`section=null`），省略如实记数。
//   判据是**计数**（`isPointerCandidate`），不是打分；默认开（`pointerTier:false` 才回到两级）。

import fs from 'node:fs';
import { extractErrorKey } from './topic.mjs';
import { loadSignatureIndex, lookupSignature } from './sigindex.mjs';
// T347：F3 是 claim 文本的**纯函数** ⇒ 读时派生兜底，历史 claim（无该字段）也能上卡，且不动数据。
import { deriveFalsifiableWhen } from './extract.mjs';
import { markerWithPolarity, detectPolarity, isCold, decayWeight } from './abstain.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CARD_VERSION = 1;
/** 命中展开的条数上限（方案 §7.3：≤5 条）。 */
export const ENTRY_LIMIT = 5;
/** 命中展开的 token 预算（方案 §7.2 六条纪律 3：≤500 tokens）。口径 = indexLine + section 合计（保守）。 */
export const BUDGET_TOKENS = 500;
/** 首轮一行 INDEX 指针的预算（方案 §7.3：~40 tokens；这里放宽到 60 作为闸值）。 */
export const INDEX_LINE_BUDGET = 60;
/** 单条文本渲染上限（超预算时「先降表示，不丢来源与日期」：160 → 60 两级）。 */
export const TEXT_CLIP = 160;
/**
 * T345 · F3 尾注的字符上限（**派生内容**，不占正文预算）。
 * 目的：让模型知道「什么情况算我错」，又不让卡片被条件句撑爆。
 * 口径：单条 ≤ F3_MAX_CHARS 字符；超了截断并保留规则 id 可追溯。
 */
export const F3_MAX_CHARS = 60;
/** 降表示第二级的单条文本上限。 */
export const TIGHT_CLIP = 60;
export const SHADOW_DIR_REL = path.join('evidence', 'shadow');
export const SHADOW_FILE = 'shadow.jsonl';

/** 记忆卡里出现即违规的指令式片段（R13 边界闸的正则来源；单源，避免注入文本与闸门漂移）。 */
export const IMPERATIVE_PATTERNS = Object.freeze([
  '你应该',
  '请',
  '下一步',
  '建议',
  '务必',
  '记得',
  '不要忘记',
  '可以试试',
]);

/** 工具治理痕迹（docs/记忆的职责边界.md §5 表的一行；机械可判，零假阳性代价低）。 */
export const GOVERNANCE_PATTERNS = Object.freeze([
  /permission:\s*(allow|ask|deny)/i,
  /\bapproval\s*:/i,
  /\bsandbox_permissions\b/i,
]);

/**
 * 一条记忆行（模型可见字符串）的权威形态：
 *   `- [antipattern] 文本  (ep-9c11, 2026-11-01, seq 88)`
 * 闸 0 用它逐行核 provenance 与日期；R12 用它产出，二者不能各写一份。
 * T347：允许坐标后跟**可选 F3 尾注**（` · 当…不再成立 [rule]`）；第 2 组仍是逐字正文，
 * 闸 0 的日期/seq 只从坐标组取 —— 派生内容不参与 provenance 核验。
 */
export const PROVENANCE_LINE_RE = /^- \[([^\]\n]+)\] (.+?) \((ep-[A-Za-z0-9._-]+), (\d{4}-\d{2}-\d{2}), seq (\d+)\)(?: · .+)?$/;

/** `indexLine` 的形态：事实陈述，不是指令。 */
export const INDEX_LINE_RE = /^MEMORY: .+（scope=.+, (\d+) 局, 未列出≠不存在）$/;

/**
 * 标记语义（声明式，只说「标记是什么意思」）——随 section 一起出现，让单看一行也能读。
 * 这一段是**事实陈述**：没有祈使句、没有「何时该查」。
 */
export const MARKERS_LINE = '# markers: [semantic]=≥3 局且无反例 · [candidate]=2 局 · [observed]=1 局 · [disputed]=存在反例 · [stale]=条件已变只给指针 · [antipattern]=失败教训 · 日期=occurredAt(UTC)';

// ---------------------------------------------------------------------------
// T3 · 三级交付的第二级：「拿不准给指针」
//
// 此前只有两级：有把握给全文（`content`）/ 无关不给（`abstain`）。中间缺一级 ——
// **只有 1 局支撑、没有第二种证据**的记忆，给全文会**冒充断言**（模型会当它已经被反复验证），
// 不给又会丢掉线索。这一级只给 `episode + seq + occurredAt`：模型可以自己去查，
// **比全文省 token，也不误导**（卡上没有一句我们不敢担保的话）。
//
// 判据**必须机械**（AGENTS §2.3「计数不是打分」）—— 两条同时成立才降级：
//   ① `state === 'observed'`：本仓 marker 语义里 `observed` 就是「1 局」；
//   ② `support.length <= POINTER_SUPPORT_LIMIT`（=1）：计数也必须是 1。
// 只有 ①（标了 observed 但支撑 ≥2）⇒ **计数是硬事实，按计数走，照常给全文**；
// 只有 ②（支撑 1 却标了 candidate/semantic）⇒ 状态自相矛盾，**按最保守的"不降级"走**
// （宁可多给，不许把有把握的条目降成指针）。
// ---------------------------------------------------------------------------

/** 「没把握」的支撑局数上限（含）。计数口径 = `claim.support.length`（**不按作用域过滤**）。 */
export const POINTER_SUPPORT_LIMIT = 1;

/**
 * 三级交付的**生产默认值**（单一来源）。
 *
 * `buildMemoryCard` / `collectEntries` 的默认参数、`src/plugin.mjs` 的 `DEFAULT_CONFIG`
 * 全读这一个常量 —— 免得出现「函数默认关、插件默认开」两套默认值各写一份
 * （D5 的 `!== false` 陷阱就是同一个坑：**未设置**被当成**开启**）。
 *
 * 默认值本身是**行为开关**：`true` = 生产链路给指针行（与 `evidence/T3-pointer-tier.md` 的
 * 前后对照口径一致）；`false` = 与 0.8.46 逐字节一致（只作 A/B 对照与紧急回退）。
 *
 * 0.8.49 起**默认开**：A6 文字层已补机械豁免（指针行不进 A6 分子分母），
 * 且"有把握"（`support >= 2` / 非 `observed`）的场景逐字节不变（T3 ③ 钉住）。
 */
export const POINTER_TIER_DEFAULT = true;

/**
 * 指针行正文的**固定尾段**（单一来源：`pointerBodyOf` 渲染它，`POINTER_BODY_RE` 用它判定）。
 * 「原文未给」是这张卡的事实（该坐标有原文、卡上没有给），不是对模型的安排。
 */
const POINTER_BODY_TAIL = '原文未给';

/**
 * 指针行正文的**唯一形态**：`<N> 局支撑 · 原文未给`。
 *
 * 消费方是 A6 文字层的机械豁免（`scripts/audit-card-samples.mjs` 的 `isPointerBody`）：
 * 指针行**故意**没有逐字正文（正文位置只有计数），所以它既不进 A6 分子、也不进分母
 * —— 与 `unreadable` / `unresolved` 同类（「没得核」，不是「核不过」）。
 * 判据是归一化后**逐字等于**这个形态，不是「包含」：少一个字符都不豁免。
 */
export const POINTER_BODY_RE = new RegExp(`^\\d+ 局支撑 · ${POINTER_BODY_TAIL}$`);

/**
 * 这一条 claim 是否「没把握 ⇒ 只给指针」。
 * 纯函数、只看计数与状态标记；不看模型评分、不看信号、不看时间。
 * @param {object} claim
 * @returns {boolean}
 */
export function isPointerCandidate(claim) {
  if (!claim || typeof claim !== 'object') return false;
  const state = typeof claim.state === 'string' && claim.state ? claim.state : 'observed';
  if (state !== 'observed') return false;
  const support = Array.isArray(claim.support) ? claim.support : [];
  return support.length > 0 && support.length <= POINTER_SUPPORT_LIMIT;
}

/**
 * 指针行的正文（**只写计数，不写断言**）。
 * `原文未给` 是这张卡的事实（该坐标有原文、卡上没有给），不是对模型的安排。
 * @param {object} claim
 * @returns {string}
 */
export function pointerBodyOf(claim) {
  const n = Array.isArray(claim?.support) ? claim.support.length : 0;
  // 尾段与 `POINTER_BODY_RE` 共用同一个常量（单一来源；测试钉住两者一致）。
  return `${n > 0 ? n : 1} 局支撑 · ${POINTER_BODY_TAIL}`;
}

/**
 * 三级交付的卡片级判定（**纯函数**，只读 `section` 与 `claims[].delivery`）。
 * @param {object} card
 * @returns {'content'|'pointers'|'abstain'}
 *   - `content`  —— 展开段里至少有一行给了全文；
 *   - `pointers` —— 有展开段，但**每一行都是指针**（只给坐标）；
 *   - `abstain`  —— 没有展开段（零注入：无关 / 无源 / 预算放不下）。
 */
export function tierOf(card) {
  const claims = Array.isArray(card?.claims) ? card.claims : [];
  if (!card || !card.section || claims.length === 0) return 'abstain';
  return claims.every((c) => c && c.delivery === 'pointer') ? 'pointers' : 'content';
}

export class InjectError extends Error {
  constructor(message, code = 'inject/error', detail = null) {
    super(message);
    this.name = 'InjectError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 度量与日期（跨房间同口径：CJK 1.5 字/token、ASCII 4 字/token，与 R11 walk 一致）
// ---------------------------------------------------------------------------

/** 粗估 token：CJK/全角按 1.5 字/token，其余按 4 字/token，向上取整。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0x2e7f) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** epoch ms → `YYYY-MM-DD`（UTC；与 R07 `formatDay(ms,'UTC')` 同口径，跨机可复算）。 */
export function formatCardDate(ms) {
  if (!Number.isFinite(ms)) return '????-??-??';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 单行化：记忆行必须一行一条（多行会破坏 provenance 行格式）。 */
export function singleLine(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 扫描一段模型可见文本里的指令式片段。
 * @returns {Array<{pattern:string, at:number, excerpt:string}>}
 */
/**
 * 2026-11-04（0.138.0）：**误伤表** —— 有些"祈使模式"其实是普通词的一部分。
 * 线上实测（1192 条 claim 全库扫）：`请` 命中 51 次里绝大多数是 `请求`（HTTP request，本仓的日常名词），
 * `记得` 命中 11 次里大半是 `我记得`（叙述）。这些不是指令，却被边界闸当成指令 ⇒ 整张卡被拦/整行被丢。
 * 只加了最小排除集：`请` 后面是 求/示/假/教，或前面是 申/邀/聘/提/恳/呈/敬/回；`记得` 前面是 我/不/还/也/都/你。
 */
export const IMPERATIVE_EXCLUSIONS = Object.freeze({
  // 键与字符一律用码位写，避免边界审计把**规则表本身**当成注入里的祈使句（自检踩过）。
  '\u8bf7': { before: new Set(['\u7533', '\u9080', '\u8058', '\u63d0', '\u6073', '\u5448', '\u656c', '\u56de']), after: new Set(['\u6c42', '\u793a', '\u5047', '\u6559', '\u67ec']) },
  '\u8bb0\u5f97': { before: new Set(['\u6211', '\u4e0d', '\u8fd8', '\u4e5f', '\u90fd', '\u4f60']), after: new Set([]) },
});

function isExcludedHit(text, pattern, at) {
  const rule = IMPERATIVE_EXCLUSIONS[pattern];
  if (!rule) return false;
  const before = at > 0 ? text[at - 1] : '';
  const after = text[at + pattern.length] ?? '';
  return rule.before.has(before) || rule.after.has(after);
}

export function auditImperatives(text) {
  const s = String(text ?? '');
  const out = [];
  if (!s) return out;
  for (const pattern of IMPERATIVE_PATTERNS) {
    let from = 0;
    for (;;) {
      const at = s.indexOf(pattern, from);
      if (at < 0) break;
      if (isExcludedHit(s, pattern, at)) { from = at + pattern.length; continue; }
      const start = Math.max(0, at - 12);
      const end = Math.min(s.length, at + pattern.length + 12);
      out.push({ pattern, at, excerpt: s.slice(start, end).replace(/\s+/g, ' ').trim() });
      from = at + pattern.length;
    }
  }
  return out.sort((a, b) => (a.at - b.at) || String(a.pattern).localeCompare(String(b.pattern)));
}

/** 单行化 + 截断（降表示的第一级：先截文本，不丢日期与出处）。 */
export function clipLine(text, max = TEXT_CLIP) {
  const s = singleLine(text);
  if (s.length <= max) return s;
  const cut = Math.max(0, max - 1);
  const head = s.slice(0, cut);
  // 2026-11-04（0.133.0）：截断尽量落在**空白边界**上。原来的硬截会把词切一半（线上实测切出 `….ou…`），
  // 卡上文字就不再是"原文的连续前缀"，A6 的文字层核对只能靠宽容匹配。保留 ≥60% 内容才回退到边界，否则硬截。
  const ws = Math.max(head.lastIndexOf(' '), head.lastIndexOf(String.fromCharCode(9)));
  const base = ws > 0 && ws >= Math.floor(cut * 0.6) ? head.slice(0, ws) : head;
  return `${base}…`;
}

// ---------------------------------------------------------------------------
// 信号：当前会话 → 检索输入（契约 §7.1）
// ---------------------------------------------------------------------------

/** CJK 2-gram 的停用表（只丢无判别力的虚词/套话；不做语义判断）。 */
const STOP_TERMS = new Set([
  '这个', '那个', '时候', '问题', '需要', '可以', '如果', '因为', '所以', '然后', '现在',
  '我们', '你们', '他们', '已经', '还是', '就是', '什么', '怎么', '一个', '没有', '不是',
  '这些', '那些', '以及', '并且', '但是', '不过', '一下', '这里', '那里', '这样', '那样',
]);

/**
 * 根消息文本 → signal（纯机械：ASCII 词 + CJK 2-gram + 路径/域名/错误码实体）。
 * 不判断「像不像主题」，也不调模型：词表由 R04 主题索引去对齐。
 */
export function signalFromText(text, { at = null, kind = 'root-message' } = {}) {
  const raw = String(text ?? '');
  const terms = new Set();
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9_./@-]{2,}/g)) terms.add(m[0].toLowerCase());
  for (const run of raw.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const g = run.slice(i, i + 2);
      if (!STOP_TERMS.has(g)) terms.add(g);
    }
  }

  const entities = [];
  const seen = new Set();
  const addEntity = (kindName, key) => {
    const k = String(key ?? '').replace(/[，。；、）】\],.;:!?]+$/, '');
    if (k.length < 2) return;
    const sig = `${kindName}\u0000${k}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entities.push({ kind: kindName, key: k });
  };
  for (const m of raw.matchAll(/[A-Za-z]:[\\/][^\s"'`，。；）]+/g)) addEntity('file', m[0]);
  for (const m of raw.matchAll(/https?:\/\/([^\s/"'`）]+)/gi)) addEntity('domain', m[1]);
  for (const m of raw.matchAll(/\b(?:[a-z0-9][a-z0-9-]*\.)+(?:com|cn|org|net|io|dev|app|ai)\b/gi)) addEntity('domain', m[0]);
  for (const m of raw.matchAll(/\bE[A-Z]{3,}\b|\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g)) addEntity('error', m[0]);

  return {
    kind: typeof kind === 'string' && kind ? kind : 'root-message',
    terms: [...terms].sort(),
    entities,
    at: Number.isFinite(at) ? at : null,
  };
}

/** `D:\work\demo` / `d:/work/demo` → `w:d:/work/demo`（与 R00 episode.scopeKey 同口径）。 */
export function scopeKeyFromPath(p) {
  const s = String(p ?? '').trim();
  if (!s) return 'w:<unknown>';
  const posix = s.replace(/\\/g, '/').replace(/\/+$/, '');
  return `w:${posix.replace(/([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`)}`;
}

/** scopeKey 规范化（`u:` 层保持小写；`w:` 与裸路径走同一口径）。作用是让"同一作用域"只有一种写法。 */
export function normalizeScopeKey(scopeKey) {
  const s = String(scopeKey ?? '').trim();
  if (!s) return '';
  if (/^u:/i.test(s)) return `u:${s.slice(2).toLowerCase()}`;
  if (/^w:/i.test(s)) return scopeKeyFromPath(s.slice(2));
  return scopeKeyFromPath(s);
}

/**
 * "拿不到当前工作区"的哨兵：R00 的 `w:unknown`、R12 的 `w:<unknown>`、空体。
 * 命中它时**不判**作用域（判不了），交给上层按"未核"处理，而不是把整卡判成越界。
 */
export function isUnknownScope(scopeKey) {
  const n = normalizeScopeKey(scopeKey);
  return n === '' || n === 'w:unknown' || n === 'w:<unknown>' || n === 'w:';
}

/**
 * 条目作用域在当前作用域下是否可见（方案 §4.10「只允许显式祖先；默认不可见」）：
 *   - 完全相同 ⇒ 可见
 *   - `u:` 用户层 ⇒ 任何 `w:` 作用域都可见（跨项目的"你"）
 *   - 当前 scope 是该条目的**子路径**（`w:d:/work/repo/plugin` 看 `w:d:/work/repo`）⇒ 可见
 *   - 反向（父看子）/ 完全不同的工作区 ⇒ 不可见
 * R12 用它过滤 walk 命中，R13 闸 1 用它判越界 —— 同一份实现，不复制。
 */
export function isScopeVisible(entryScope, currentScope) {
  const entry = normalizeScopeKey(entryScope);
  const current = normalizeScopeKey(currentScope);
  if (!entry || !current) return false;
  if (entry === current) return true;
  if (entry.startsWith('u:') && current.startsWith('w:')) return true;
  if (entry.startsWith('w:') && current.startsWith('w:')) {
    const base = entry.slice(2);
    const leaf = current.slice(2);
    return leaf === base || leaf.startsWith(`${base}/`);
  }
  return false;
}

/**
 * 按当前作用域过滤 walk 命中（R11 暂不接收 scope 参数时的 R12 侧兜底）。
 * 判据同闸 1：**证明不了在本域可见的就不注入**（`u:` 层例外）。
 * 丢掉的两类分开计数，好让省略行说清"为什么少了"：
 *   - `dropped`：明确在别的作用域（crossScope）
 *   - `droppedUnknown`：命中没带 scopeKey，无法证明可见（默认不可见）
 */
export function filterHitsByScope(hits, scope) {
  const list = Array.isArray(hits) ? hits : [];
  const current = normalizeScopeKey(scope);
  if (!current || isUnknownScope(current)) return { hits: list.slice(), dropped: 0, droppedUnknown: 0, scope: null };
  const kept = [];
  let dropped = 0;
  let droppedUnknown = 0;
  for (const hit of list) {
    const entryScope = typeof hit?.scopeKey === 'string' && hit.scopeKey.trim() !== '' ? hit.scopeKey : '';
    if (!entryScope) {
      droppedUnknown += 1;
      continue;
    }
    if (isScopeVisible(entryScope, current)) kept.push(hit);
    else dropped += 1;
  }
  return { hits: kept, dropped, droppedUnknown, scope: current };
}

// ---------------------------------------------------------------------------
// store 读视图（只读；只用 list/get/counts 三个方法，缺 store 时全部降级为空）
// ---------------------------------------------------------------------------

const VIEW_CACHE = new WeakMap();

function storeView(store, cache = null) {
  if (cache && typeof cache === 'object') {
    const hit = VIEW_CACHE.get(cache);
    if (hit) return hit;
  }
  const view = {
    indexPath: null,
    episodeCount: 0,
    claims: [],
    claimsById: new Map(),
    claimsByEpisode: new Map(),
    episodesById: new Map(),
    missing: true,
  };
  if (!store || typeof store.list !== 'function') return view;
  view.missing = false;
  view.indexPath = typeof store.indexPath === 'string' ? store.indexPath : null;

  try {
    const counts = typeof store.counts === 'function' ? store.counts() : null;
    if (counts && Number.isFinite(counts.episodes)) view.episodeCount = counts.episodes;
  } catch { /* 计数失败不阻塞注入：0 局如实写 0 */ }

  try {
    const claimItems = cache?.claims ? cache.claims.map((rec) => ({ record: rec })) : store.list('claims');
    for (const item of claimItems) {
      const rec = item?.record;
      if (!rec || typeof rec.text !== 'string') continue;
      const claim = {
        id: typeof rec.id === 'string' ? rec.id : (item.id ?? null),
        kind: typeof rec.kind === 'string' ? rec.kind : 'fact',
        state: typeof rec.state === 'string' ? rec.state : 'observed',
        text: rec.text,
        occurredAt: Number.isFinite(rec.occurredAt) ? rec.occurredAt : null,
        support: Array.isArray(rec.support) ? rec.support.filter((s) => s && typeof s === 'object') : [],
        // Q19-B 需要 hard/soft 区分；投影时别把 level 丢掉（2026-11-03 实测踩过）
        level: typeof rec.level === 'string' ? rec.level : null,
        // T162a：合并节点标记（consolidate 写的 merge.members / representative）；没有就 null。
        merge: rec.merge && typeof rec.merge === 'object' ? rec.merge : null,
        // T345：F3 失效条件（文本派生）。**投影必须带上**，否则卡上永远看不到（2026-11-06 实测踩过）。
        falsifiableWhen: rec.falsifiableWhen && typeof rec.falsifiableWhen === 'object' ? rec.falsifiableWhen : null,
      };
      view.claims.push(claim);
      if (claim.id) view.claimsById.set(claim.id, claim);
      const episodes = new Set(claim.support.map((s) => String(s.episode ?? '')).filter(Boolean));
      for (const ep of episodes) {
        if (!view.claimsByEpisode.has(ep)) view.claimsByEpisode.set(ep, []);
        view.claimsByEpisode.get(ep).push(claim);
      }
    }
  } catch { /* 坏条目跳过：注入宁可少一条，也不抛 */ }

  try {
    const episodeItems = cache?.episodes ? cache.episodes.map((rec) => ({ record: rec })) : store.list('episodes');
    for (const item of episodeItems) {
      const rec = item?.record;
      if (rec && typeof rec.id === 'string') view.episodesById.set(rec.id, rec);
    }
  } catch { /* 同上 */ }

  if (cache && typeof cache === 'object') VIEW_CACHE.set(cache, view);
  return view;
}

// ---------------------------------------------------------------------------
// hit → 一条记忆行（优先 claim 原文；退化时只给指针）
// ---------------------------------------------------------------------------

const RANK = Object.freeze({
  antipattern: 0,
  failure: 0.5,
  preference: 1,
  rule: 1,
  constraint: 1.5,
  fact: 2,
  pointer: 2,
  pattern: 3,
  joseki: 3,
});

function rankOf(kind) {
  return Number.isFinite(RANK[kind]) ? RANK[kind] : 2;
}

function compareClaims(a, b) {
  return (rankOf(a.kind) - rankOf(b.kind))
    || ((a.occurredAt ?? 0) - (b.occurredAt ?? 0))
    || String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/**
 * 一个 hit 该用哪条 claim 来陈述（按可靠性降序）：
 *   1. hit 自带 claim 对象（含 text）——调用方已经把原文给了；
 *   2. hit.claim = claims/<id>.json 的 id（R11 walk 的形态）→ 回到 store 取原文与 support（能拿到精确 seq/edgeId）；
 *   3. hit.claimId（兼容别名）；
 *   4. hit.claimKind + hit.text（walk 已经带了 claim 摘要字段，但 store 里查不到时用它，不丢内容）；
 *   5. 该局里**锚定同一个 seq** 的 claim（同一事件）。
 * 第 5 条故意收紧：没有 claim 指向命中事件时**不随手抓一条该局别的 claim**（那正是 F8「顺藤摸错枝」），
 * 而是退回指针行。全部按 (episode, seq, occurredAt) 校验，缺源的一律不入卡。
 */
/** 合并节点（带 merge.members 的 claim）**不参与 claim 选取** —— 它只作为成员的替代行出现（T187）。 */
function isMergeNodeClaim(claim) {
  return Boolean(claim && typeof claim === 'object' && claim.merge && typeof claim.merge === 'object' && Array.isArray(claim.merge.members));
}

function pickClaimBase(hit, view) {
  if (hit?.claim && typeof hit.claim === 'object' && typeof hit.claim.text === 'string') {
    const c = hit.claim;
    return {
      id: typeof c.id === 'string' ? c.id : null,
      kind: typeof c.kind === 'string' ? c.kind : 'fact',
      state: typeof c.state === 'string' ? c.state : 'observed',
      text: c.text,
      occurredAt: Number.isFinite(c.occurredAt) ? c.occurredAt : null,
      support: Array.isArray(c.support) ? c.support.filter((s) => s && typeof s === 'object') : [],
    };
  }
  const claimId = typeof hit?.claim === 'string' ? hit.claim : (typeof hit?.claimId === 'string' ? hit.claimId : null);
  if (claimId && view.claimsById.has(claimId)) return view.claimsById.get(claimId);
  if (claimId && typeof hit?.text === 'string' && hit.text.trim() !== '') {
    // store 里没有这条 claim（可能已被裁掉）：用 walk 带回来的摘要字段，出处仍取 hit 的 (episode, seq)。
    return {
      id: claimId,
      kind: typeof hit?.claimKind === 'string' && hit.claimKind ? hit.claimKind : 'fact',
      state: typeof hit?.claimState === 'string' && hit.claimState ? hit.claimState : 'observed',
      text: hit.text,
      occurredAt: Number.isFinite(hit?.occurredAt) ? hit.occurredAt : null,
      support: [],
    };
  }
  const list = view.claimsByEpisode.get(String(hit?.episode ?? '')) ?? [];
  if (!list.length || !Number.isFinite(hit?.seq)) return null;
  const anchored = list.filter((c) => !isMergeNodeClaim(c) && c.support.some((s) => Number(s.seq) === Number(hit.seq)));
  if (!anchored.length) return null;
  return [...anchored].sort(compareClaims)[0];
}

function stateTokenOf(claim) {
  if (claim.kind === 'antipattern') return 'antipattern';
  const state = typeof claim.state === 'string' && claim.state ? claim.state : 'observed';
  return state;
}

function buildEntry({ prefix = '', episode, seq, occurredAt, marker, state, text, kind, claimId = null, edgeId = null, cost = null, falsifiableWhen = null, decay = 1,
  // T3：`delivery === 'pointer'` ⇒ 这一行只给指针（正文是计数，不是断言）。
  // `claimText` 只在这时出现：它是**那条记忆的正文**，留在结构化字段里（相关性判定要用），
  // **不进 `rawText`** —— 渲染只认 `rawText`，所以卡上不会出现没把握的断言。
  delivery = 'content',
  claimText = null }) {
  // 2026-11-04（0.134.0，线上实测）：seq 是 **1 基**的；`seq: 0` 等于「不知道在哪」，不是合法出处。
  // 当前宿主 60 条引用里就有 2 条落在 seq 0，卡上文字在该局里找不到 ⇒ A6 文字层报 missing。
  // 回到根本规矩：无源不入 —— seq < 1 的条目不进卡（计入 omitted，而不是渲染一条查无实据的行）。
  if (!episode || !Number.isFinite(seq) || seq < 1 || !Number.isFinite(occurredAt)) return null;
  const rawText = singleLine(`${prefix}${text}`);
  if (!rawText) return null;
  const date = formatCardDate(occurredAt);
  return {
    rawText,
    kind,
    marker,
    // T333：cost 只作**同分次序**（tokOverlap/rank 等主键都相同才比），不参与硬过滤。
    cost: Number.isFinite(cost) ? cost : null,
    // 知识库 91：**衰减权重**（0..1，最近被调用 ⇒ 1；很久没被调用 ⇒ 接近 0）。
    // 用作 `compareEntries` 的**次排序因子**（在 rank 之后，权重高的排前面）。
    // **被调用时重置**（`lastInjectedAt` 更新 ⇒ 权重回到 1）；没有时间 ⇒ 1（保守，当作"新"）。
    decay: Number.isFinite(decay) ? decay : 1,
    // T345：F3 失效条件是**派生内容**（非逐字），只作坐标后的尾注，绝不混进 rawText（否则 A6 文字层报 missing）。
    f3: falsifiableWhen && falsifiableWhen.when
      ? { rule: String(falsifiableWhen.rule ?? ''), when: String(falsifiableWhen.when).slice(0, F3_MAX_CHARS) }
      : null,
    state: state ?? marker,
    occurredAt,
    date,
    claimId,
    source: { episode, seq, ...(edgeId ? { edgeId } : {}) },
    rank: rankOf(kind),
    // T3：**只给指针**的行多两个字段（content 行的结构一字不改，旧消费方拿到的还是老形状）。
    ...(delivery === 'pointer' ? { delivery: 'pointer', claimText: claimText ?? rawText } : {}),
  };
}

/** 信号侧的判别词（口径与 m5 A2b 同源：小写、按非字母数字切、≥4 字符、去掉 path）。 */
export function signalTokensOf(signal) {
  const parts = [];
  for (const t of Array.isArray(signal?.terms) ? signal.terms : []) parts.push(String(t));
  for (const e of Array.isArray(signal?.entities) ? signal.entities : []) parts.push(String(e?.key ?? ''));
  const out = [];
  for (const part of parts) {
    for (const tok of String(part).toLowerCase().split(/[^a-z0-9一-鿿]+/)) {
      if (tok.length >= 4 && tok !== 'path') out.push(tok);
    }
  }
  return [...new Set(out)];
}

/**
 * 挑「展示用的那条 support」：类级 claim 把同类多条错误收在一条上、只存一个代表原文，
 * 所以固定取 hit.seq 那条时，卡片会把「工具箱坏了」的泛教训端上来、却不点名这次是哪条错（2026-11-04 实测 2 条）。
 * 规则：在同域 support 里挑与本次信号判别词重叠最多的那条；只有明显更好（≥2 且优于原选）才替换，
 * 否则保持原行为（不为了换而换，避免把卡片变成"随机挑一条"）。
 */
function pickSourceBySignal(support, { signalTokens = [], currentSeq = null, fallback = null } = {}) {
  if (!Array.isArray(support) || support.length < 2 || !Array.isArray(signalTokens) || signalTokens.length === 0) return fallback;
  const scoreOf = (sup) => {
    const q = String(sup?.quote ?? '').toLowerCase();
    if (!q) return -1;
    return signalTokens.filter((t) => q.includes(t)).length;
  };
  let best = fallback;
  let bestScore = fallback ? scoreOf(fallback) : -1;
  for (const sup of support) {
    const score = scoreOf(sup);
    if (score > bestScore) { best = sup; bestScore = score; }
    else if (score === bestScore && Number.isFinite(currentSeq) && Number(sup?.seq) === Number(currentSeq)) { best = sup; }
  }
  return bestScore >= 2 ? best : fallback;
}

function entryFromClaim(hit, claim, options = {}) {
  // T252（2026-11-05）：`invalidated` 的 claim 一律不渲染。
  // walk 的候选集早已剔除它（`dropped.invalidated`），但 hit 自带 claim 对象、
  // 或 hit 直接点名 claimId 的**旁路**会绕过那道过滤 —— 这里在渲染入口再堵一次。
  // stale / disputed **不在此列**：它们仍进卡并带各自 marker（有信息量）。
  if (claim && claim.state === 'invalidated') return null;
  // T298（知识库 64）：stale / `validUntil` 过期 **不占位**；preconditions 重跑通过 ⇒ 可复活。
  if (claim) {
    const revived = typeof options.preconditionOk === 'function' ? options.preconditionOk(claim) === true : false;
    if (!revived) {
      if (claim.state === 'stale') return null;
      const vu = Number(claim.validUntil);
      const nowTs = Number.isFinite(options.now) ? Number(options.now) : Date.now();
      if (Number.isFinite(vu) && vu < nowTs) return null;
    }
  }
  // 2026-11-04（M4 线上抽查发现）：u:owner 类级 claim 的 support 跨多个工作区，
  // 直接取 support[0] 会把"别项目的失败原文 + ep"渲染进本项目的卡（A5 的实质越界）。
  // 这里只选**同作用域**的 support；同作用域一条都没有 ⇒ 不渲染（返回 null）。
  const all = Array.isArray(claim.support) ? claim.support : [];
  const scope = typeof options.scope === 'string' && options.scope ? options.scope : null;
  const byId = options.episodesById instanceof Map ? options.episodesById : null;
  // Q18（默认关）：开关 + 类级章节 + 该 hit 由 walk 标了 class:cross-scope ⇒ 允许跨域证据，并在行首标 [跨项目]。
  // walk 只有在 allowCrossScopeClass 打开时才会给 hit 打 `class:cross-scope`；
  // 所以这里只看这个标记，卡片本身不需要再传开关（Q18 由 walk 一处控制）。
  const crossAllowed = String(claim.text ?? '').startsWith('class:')
    && Array.isArray(hit?.why) && hit.why.includes('class:cross-scope');
  const support = scope && byId && !crossAllowed
    ? all.filter((sup) => {
      const rec = byId.get(String(sup?.episode ?? ''));
      // 查不到该局（测试夹具/库未加载到）⇒ 无法证明越界，保留；查得到且明确别的作用域 ⇒ 丢掉。
      if (!rec || typeof rec.scopeKey !== 'string') return true;
      return rec.scopeKey === scope;
    })
    : all;
  if (!support.length && all.length) return null; // 有 support 但全属别的作用域 ⇒ 不渲染
  let src = null;
  if (Number.isFinite(hit?.seq)) src = support.find((s) => Number(s.seq) === Number(hit.seq)) ?? null;
  if (!src) src = support.find((s) => String(s.episode) === String(hit?.episode ?? '')) ?? support[0] ?? null;
  // T111（0.122.0）：同域 support 里若有原文更贴近本次信号，就展示那条（否则保持原选）。
  src = pickSourceBySignal(support, { signalTokens: options.signalTokens, currentSeq: Number.isFinite(hit?.seq) ? Number(hit.seq) : null, fallback: src });

  const episode = typeof src?.episode === 'string' && src.episode
    ? src.episode
    : (typeof hit?.episode === 'string' ? hit.episode : '');
  const seq = Number.isFinite(src?.seq) ? Number(src.seq) : (Number.isFinite(hit?.seq) ? Number(hit.seq) : null);
  // 2026-11-04（audit-11 实测）：原先「文字取 claim.text / 坐标取 src / 日期取 claim.occurredAt」三者可脱钩 ——
  // 线上 44 条引用里 15 条的文字只在**本局别处**出现、1 条本局根本没有那段文字，还有 34/44 的日期不是所引那条事件的时间。
  // 注入只能是事实：卡上的每个字都必须落在它自己标注的 (ep, seq) 上，所以
  //   ① 文字取 `src.quote`（该 seq 的原文；claim 的 `class:<token>` 是机械标签，保留成前缀）；
  //   ② 日期取 `src.occurredAt`（所引那条事件的时刻）；
  //   ③ 只有旧夹具/旧数据缺 `quote` 时才退回 `claim.text` —— 那不是"允许脱钩"，而是让
  //      `scripts/audit-card-samples.mjs` 能把它抓成 elsewhere/missing 的可见失败（真实库里 quote 1661/1661 齐全）。
  const label = /^class:[^\s·]+/.exec(String(claim.text ?? ''))?.[0] ?? null;
  const quote = typeof src?.quote === 'string' ? src.quote.trim() : '';
  const body = quote || String(claim.text ?? '').trim();
  const text = body ? (label && !body.startsWith(label) ? `${label} · ${body}` : body) : null;
  if (!text) return null;
  const occurredAt = Number.isFinite(src?.occurredAt)
    ? Number(src.occurredAt)
    : (Number.isFinite(claim.occurredAt) ? claim.occurredAt : (Number.isFinite(hit?.occurredAt) ? hit.occurredAt : null));
  // T3（三级交付的第二级）：**没把握 ⇒ 只给指针**（判据见 `isPointerCandidate`，纯计数）。
  // **默认开**（`options.pointerTier === false` 才回到两级）：开/关的判据只有这一处收口，
  // 关掉时卡片与 0.8.46 逐字节一致（前后对照见 `evidence/T3-pointer-tier.md`）。
  const pointer = options?.pointerTier === true && isPointerCandidate(claim);

  return buildEntry({
    episode,
    seq,
    occurredAt,
    // 知识库 84：传了 `options.signalText` 时，**与信号方向相反**的 claim 标 `[disputed]`（不以"建议"出现）。
    // **不传 ⇒ 保持 `stateTokenOf(claim)`（行为不变，向后兼容）**。
    // T3：指针行也保留这个标记 —— 它是**那条记忆的状态事实**，与"给不给正文"是两件事。
    marker: options?.signalText
      ? markerWithPolarity(claim, detectPolarity(options.signalText, text))
      : stateTokenOf(claim),
    cost: Number.isFinite(options?.costIndex?.get?.(String(claim.id ?? ''))) ? options.costIndex.get(String(claim.id ?? '')) : null,
    // 知识库 91：**衰减权重**（最近被调用 ⇒ 1；很久没被调用 ⇒ 接近 0），用作 `compareEntries` 的次排序因子。
    decay: decayWeight(claim, options.now),
    // T345/T347：F3 优先用 claim 上存的；没有（历史 claim）⇒ **读时派生兜底**（纯函数、确定性）。
    // `f3OnCard:false` 只给 A/B 对照与紧急关闭用。
    // T3：**指针行不带 F3** —— F3 是正文的适用条件，指针行没有正文；带上它等于把没把握的断言的一部分塞回来。
    falsifiableWhen: pointer ? null : (options?.f3OnCard === false ? null : (claim.falsifiableWhen ?? deriveFalsifiableWhen(body))),
    ...(crossAllowed ? { prefix: '[跨项目] ' } : {}),
    state: typeof claim.state === 'string' && claim.state ? claim.state : 'observed',
    // T3：指针行的正文只写计数（`1 局支撑 · 原文未给`），**断言正文不进 rawText**；
    // 正文仍留在 `claimText`（结构化字段，相关性判定要用），但**不渲染**。
    text: pointer ? pointerBodyOf(claim) : text,
    delivery: pointer ? 'pointer' : 'content',
    claimText: pointer ? text : null,
    kind: claim.kind,
    claimId: claim.id,
    edgeId: typeof src?.edgeId === 'string' ? src.edgeId : null,
  });
}

/** 没有 claim 可陈述时只给指针（事实：这一局命中过这个主题、失败计数是多少）。 */
function entryFromEpisode(hit, view) {
  const rec = view.episodesById.get(String(hit?.episode ?? '')) ?? null;
  const seq = Number.isFinite(rec?.closure?.seqFrom)
    ? Number(rec.closure.seqFrom)
    : (Number.isFinite(hit?.seq) ? Number(hit.seq) : null);
  const occurredAt = Number.isFinite(rec?.startedAt)
    ? Number(rec.startedAt)
    : (Number.isFinite(hit?.occurredAt) ? hit.occurredAt : null);
  const failures = rec?.signals?.failures;
  const why = Array.isArray(hit?.why) ? hit.why.filter((x) => typeof x === 'string' && x) : [];
  const hitText = typeof hit?.text === 'string' ? hit.text.trim() : '';
  const l0 = typeof rec?.l0 === 'string' ? rec.l0.trim() : '';
  const text = hitText || l0 || `fail=${Number.isFinite(failures) ? failures : '?'} · topics=${why.slice(0, 3).join(', ') || '—'}`;
  return buildEntry({
    episode: String(hit?.episode ?? ''),
    seq,
    occurredAt,
    marker: 'observed',
    state: 'observed',
    text,
    kind: hit?.kind === 'failure' ? 'failure' : (hit?.kind === 'constraint' ? 'constraint' : 'pointer'),
  });
}

/**
 * T115（0.124.0）：**同一局里往往不止一条教训**，而 walk 命中的那个 seq（或它自带的 claim）可能锚定着
 * 与本次失败无关的类级泛教训。实测：`syntaxerror … checkSyntax` 那条考卷，5 个 hit 全落在同一局、
 * 各自只带一条"工具坏了"的泛教训，真正对得上的那条在同一局的另一个 seq 上（`claim.text` 重叠 8 vs 0）。
 * 规则：在**该局**的 claim 里挑与本次信号判别词重叠最高的那条 —— 要求 ≥2 且**严格优于**原选，
 * 否则保持原行为（不为了换而换）。出处仍由 `entryFromClaim` 从所选 claim 的 support 里取，
 * 所以「文字 / 坐标 / 日期」三者一致的不变量不受影响（A5 作用域闸也照旧在 entryFromClaim 里生效）。
 */
function pickClaim(hit, view, options = {}) {
  const base = pickClaimBase(hit, view);
  const tokens = Array.isArray(options.signalTokens) ? options.signalTokens : [];
  const episode = String(hit?.episode ?? '');
  if (!tokens.length || !episode) return base;
  const pool = (view.claimsByEpisode.get(episode) ?? []).filter((c) => !isMergeNodeClaim(c) && Array.isArray(c?.support) && c.support.length);
  if (!pool.length) return base;
  const scoreOf = (c) => {
    const t = String(c?.text ?? '').toLowerCase();
    if (!t) return -1;
    return tokens.filter((x) => t.includes(x)).length;
  };
  const baseScore = base ? scoreOf(base) : -1;
  let best = null;
  let bestScore = -1;
  for (const c of pool) {
    const sc = scoreOf(c);
    if (sc > bestScore) { best = c; bestScore = sc; }
  }
  if (best && bestScore >= 2 && bestScore > baseScore) return best;
  return base;
}

/**
 * hits → 候选条目。缺 (episode, seq, occurredAt) 的条目**直接丢**（无源不入、无时不入），
 * 只计数进省略；这样记忆卡本身不会出现「有行没出处」的形态。
 */
function collectEntries({ hits, view, scope = null, preferenceHardOnly = false, signal = null, sigIndex = null, allowCrossScopeClass = false,
  now = null,
  preconditionOk = null,
  costIndex = null,
  // T347：F3 上卡开关（默认开；关掉只用于 A/B 对照或紧急回退）
  f3OnCard = true,
  // 知识库 90：**冷却**（主人纠正："不被调用就冷却，等于没写"）。
  // **默认关**（`null` ⇒ 不过滤）：因为"冷却"依赖"注入记录"，
  // 而当前宿主只有 CLI 进程、没有真实流量，注入记录不可靠 ⇒ 默认关，不误杀。
  // 开启后，距最后注入超过 `coldAfterDays` 天的 claim **不再出现在卡片上**（**但不删**，可逆）。
  coldAfterDays = null,
  // T3：**三级交付**的第二级开关（默认值 = `POINTER_TIER_DEFAULT`，单一来源）。
  // `true` ⇒ `isPointerCandidate` 成立的条目只给指针（`episode + seq + occurredAt`），正文不渲染。
  // 关掉时卡片与 0.8.46 逐字节一致 —— 这是"旧消费方不会炸"的唯一保证。
  pointerTier = POINTER_TIER_DEFAULT,
}) {
  const entries = [];
  let droppedNoProvenance = 0;
  let droppedNoText = 0;
  let droppedSoftPreference = 0;
  let droppedCold = 0;
  let droppedImperative = 0;
  const seen = new Set();
  const cap = Math.max(ENTRY_LIMIT * 8, 40);

  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit || typeof hit !== 'object') continue;
    // T187：**指向合并节点的 hit 不成行** —— 合并节点只作为"≥2 个成员的替代行"出现。
    // 影库里 walk 会额外返回"指向合并节点"的 hit（源库没有它），若在这里退化成 episode 指针行，
    // 同一组的卡就会比源库多一行（④a 反增）；直接跳过则两库行数一致。
    const namedId = typeof hit.claim === 'string' ? hit.claim : (typeof hit.claimId === 'string' ? hit.claimId : null);
    if (namedId && isMergeNodeClaim(view.claimsById.get(namedId))) continue;
    const claim = pickClaim(hit, view, { signalTokens: signalTokensOf(signal) });
    // Q19-B 预置（默认关）：只保留 hard 约束，丢弃 soft（理由句/闲聊/复述）
    if (preferenceHardOnly && claim && claim.kind === 'preference' && claim.level !== 'hard') {
      droppedSoftPreference += 1;
      continue;
    }
    // 知识库 90：**冷却**（主人纠正："不被调用就冷却，等于没写"）。
    // `coldAfterDays` **默认关**（不设 ⇒ 不过滤，因为"冷却"依赖"注入记录"，
    // 而当前宿主只有 CLI 进程、没有真实流量，注入记录不可靠 ⇒ 默认关，不误杀）。
    // **冷却 = 不再出现在卡片上，但不删**（原件永不删，可逆：将来被调用了就"热"回来）。
    if (Number.isFinite(coldAfterDays) && coldAfterDays > 0 && claim && isCold(claim, now, { coldAfterDays })) {
      droppedCold = (droppedCold ?? 0) + 1;
      continue;
    }
    const entry = claim
      ? entryFromClaim(hit, claim, { scope, episodesById: view.episodesById, allowCrossScopeClass: allowCrossScopeClass === true, signalTokens: signalTokensOf(signal), now, preconditionOk, costIndex, f3OnCard, pointerTier,
        // 知识库 84：把**信号原文**也传下去 —— 与信号**方向相反**的 claim 标 `[disputed]`（不以"建议"出现）。
        // 取不到原文 ⇒ 空串 ⇒ `hasAnySignalHandle` 为 false ⇒ **不拒绝、不改标记**（保守，向后兼容）。
        signalText: signal?.text ?? signal?.quote ?? (Array.isArray(signal?.terms) ? signal.terms.join(' ') : '') })
      : entryFromEpisode(hit, view);
    if (entry && scope) {
      const rec = view.episodesById.get(String(hit?.episode ?? ''));
      const epScope = rec && typeof rec.scopeKey === 'string' ? rec.scopeKey : null;
      if (epScope && epScope !== scope) entry.crossScope = true;
    }
    if (!entry) {
      if (claim && !clipLine(claim.text)) droppedNoText += 1;
      else droppedNoProvenance += 1;
      continue;
    }
    // 2026-11-04（0.138.0）：边界闸对祈使句是**卡级 fail-closed** —— 线上实测有一次整张卡因此没注入。
    // 规则不变（注入内容不许有祈使句），但粒度改成**行**：这一行丢掉、其余照常注入，并在 omitted 里如实记数。
    if (auditImperatives(entry.rawText).length) {
      droppedImperative += 1;
      continue;
    }
    // 去重键（T154）：**有 claim 的条目按 claimId 去重** —— 同一条 claim 常常有多个出处
    // （support[0] / support[1] ……线上 146/1232 条 claim 如此），按 (episode, seq, 原文) 去重
    // 会把同一条断言渲染成两行；闸 4 按"归一化全文"判等，看到同一个 id 出现两次就当成
    // "未标 supersedes 的重复"，整张卡被打回（线上两次 gate4/unsuperseded-duplicate 的根因）。
    // 棋谱指针行（无 claim）保持原键：不同出处是**不同事实**，必须都保留。
    const key = entry.claimId
      ? `claim:${entry.claimId}`
      : `${entry.source.episode}\u0000${entry.source.seq}\u0000${entry.rawText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= cap) break;
  }

  // N9（2026-11-03）：按签名补"这条失败在本局/历史局里真实出现过的原文"。
  // 只**追加**、不替换既有 claim（N8 教训）；每信号最多 2 条；作用域必须一致（A5）。
  let sigAdded = 0;
  const sigKey = signal && typeof signal.text === 'string' ? extractErrorKey(signal.text) : null;
  for (const item of lookupSignature(sigIndex, sigKey, { limit: 2 })) {
    if (!item || !item.episode) continue;
    const rec = view.episodesById.get(String(item.episode));
    if (scope) {
      const epScope = rec && typeof rec.scopeKey === 'string' ? rec.scopeKey : null;
      if (!epScope || epScope !== scope) continue;
    }
    const text = String(item.snippet ?? '').trim();
    if (!text) continue;
    const dedupe = `${item.episode}\u0000${item.seq ?? ''}\u0000${text}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const entry = buildEntry({
      episode: String(item.episode),
      seq: Number.isFinite(item.seq) ? item.seq : null,
      occurredAt: Number.isFinite(item.occurredAt) ? item.occurredAt : null,
      marker: 'observed',
      state: 'observed',
      text,
      kind: 'failure',
    });
    if (!entry) continue;
    entries.push(entry);
    sigAdded += 1;
    if (entries.length >= cap) break;
  }

  return { entries, sigAdded, dropped: { noProvenance: droppedNoProvenance, noText: droppedNoText, softPreference: droppedSoftPreference, imperative: droppedImperative } };
}

function compareEntries(a, b) {
  return (a.rank - b.rank)
    // 知识库 91：**衰减权重**（次排序因子，在 rank 之后）—— 最近被调用的排前面，很久没被调用的沉底。
    // **被调用时重置**（`lastInjectedAt` 更新 ⇒ 权重回到 1）；缺 decay ⇒ 视为 1（保守，当作"新"）。
    || ((b.decay ?? 1) - (a.decay ?? 1))
    || ((b.occurredAt ?? 0) - (a.occurredAt ?? 0))
    || (String(a.source.episode) < String(b.source.episode) ? -1 : String(a.source.episode) > String(b.source.episode) ? 1 : 0)
    // T317：seq 缺失时 `a-b` 会是 NaN（被 sort 当 0 ⇒ 退回插入序）——先挡住
    || ((Number.isFinite(a.source.seq) && Number.isFinite(b.source.seq)) ? a.source.seq - b.source.seq : 0)
    // T333：**同分次序** —— 上面的主键（rank / occurredAt / episode / seq）全部相同，才比 cost：
    // 付过代价（cost > 0）排在没有代价（0 / 缺失）之前。缺 costIndex ⇒ 视为 0（不加分、不惩罚）。
    || ((Number.isFinite(b.cost) ? b.cost : 0) - (Number.isFinite(a.cost) ? a.cost : 0))
    // T317：**最后一级 = claimId 字典序** —— 同局同 seq 的两条 claim 必须可复现，
    // 不许依赖插入顺序 / Map 迭代序 / 文件系统顺序（T316 剩下的 3 条差异就出在这一级）。
    || String(a.claimId ?? '').localeCompare(String(b.claimId ?? ''));
}

// ---------------------------------------------------------------------------
// T162a 合并节点（merge）：同一张卡里「合并节点 + 成员」不许同时成行
// ---------------------------------------------------------------------------

/** 成员 id → 合并节点 claim 的索引（只在 claim 带 `merge.members` 时建）。 */
function mergeIndexByMember(view) {
  const byMember = new Map();
  for (const claim of Array.isArray(view?.claims) ? view.claims : []) {
    const merge = claim?.merge;
    if (!merge || typeof merge !== 'object' || !Array.isArray(merge.members) || !claim.id) continue;
    for (const memberId of merge.members) {
      if (typeof memberId === 'string' && memberId !== '' && memberId !== claim.id) byMember.set(memberId, claim);
    }
  }
  return byMember;
}

/**
 * 用合并节点自己的出处渲染一行（与普通 claim 行同形状：`entry.claimId` = 合并节点 id）。
 * 锚点优先 `merge.representative`，缺就从自己的 support 里挑第一条有 (episode, seq) 的；
 * 两者都没有 ⇒ 无法证明出处，返回 null（无源不入）。
 */
function entryFromMergeNode(mergeClaim, options = {}) {
  const rep = mergeClaim?.merge?.representative;
  const support = Array.isArray(mergeClaim?.support) ? mergeClaim.support : [];
  const anchor = rep && typeof rep.episode === 'string' && Number.isFinite(Number(rep.seq))
    ? { episode: rep.episode, seq: Number(rep.seq), occurredAt: Number.isFinite(rep.occurredAt) ? rep.occurredAt : null }
    : (support.find((s) => s && typeof s.episode === 'string' && Number.isFinite(Number(s.seq))) ?? null);
  if (!anchor) return null;
  const hit = {
    episode: anchor.episode,
    seq: Number(anchor.seq),
    why: [],
    occurredAt: Number.isFinite(anchor.occurredAt) ? Number(anchor.occurredAt) : (Number.isFinite(mergeClaim.occurredAt) ? mergeClaim.occurredAt : null),
    claim: mergeClaim.id,
  };
  return entryFromClaim(hit, mergeClaim, options);
}

/**
 * 卡片选取条目的最后一道：**合并节点只替换、不主动入选**。
 *
 * 规则（T176 语义 + T187 收口）：
 *   1. 合并节点**不因为自己命中而单独成行** —— 它只作为"成员的替代行"出现；
 *   2. **≥2 个成员**被命中 ⇒ 用合并节点替换这些成员行（合并节点插在第一个成员的位置）；
 *   3. 只有 1 个 / 0 个成员被命中 ⇒ 合并节点行撤掉，成员行原样保留（行数 1→1 或 0→0，不增不减）；
 *   4. 没有 `merge` 字段的 claim **一字不改** —— 不建索引、不碰顺序。
 *
 * 为什么是这三条（T187 的两次实测）：
 *   · "合并节点被命中就渲染它"（T162a）会让卡片净 +1（c-3011f83f 1→2、c-41157b78 2→3）；
 *   · "0 成员时补指针行/代表成员行"（T177 方案 C）同样净 +1，且 ④b 仍有丢行；
 *   · 真正的丢行来自 `pickClaim` 把成员命中升级成合并节点 —— 那一刀在 pickClaim 里（成员保留），
 *     这里只要保证"合并节点只在替代 ≥2 个成员时出现"，④a/④b 就同时为 0。
 *
 * 被折叠的成员行不计入 omitted（它们没丢，只是被合并节点代表了）。
 */
/**
 * T207：**冒泡行** —— 只命中 1 个成员时，用合并节点那一行 1 换 1，并在行内标注它代表什么。
 *
 * 为什么不能"多换 1"：只命中 1 条成员时折叠没有收益（行数不变），但行内标注能让模型知道
 * "这条是合并组的代表，详见合并节点"—— 这是触发面实验（P(≥1)）要观察的行为；
 * 不标注的话，冒泡与"直接渲染成员"在卡上无法区分，实验数据就读不出来。
 * 出处仍取合并节点自己的 support 锚点（闸 0 的 (episode, seq, 日期) 与闸 5 的 quote 规则照旧满足）。
 */
function entryFromMergeBubble(mergeClaim, options = {}) {
  const base = entryFromMergeNode(mergeClaim, options);
  if (!base) return null;
  const count = Array.isArray(mergeClaim?.merge?.members)
    ? mergeClaim.merge.members.filter((x) => typeof x === 'string').length
    : 0;
  return { ...base, rawText: singleLine(`代表 ${count} 条 · 详见 ${mergeClaim.id} · ${base.rawText}`) };
}

function collapseMergeNodes({ entries, view, options = {} }) {
  const list = Array.isArray(entries) ? entries : [];
  // T207：运行时计数（触发面实验的数据源；只加字段，不改任何既有语义）
  const stats = { groupsHit: 0, membersHit: 0, collapsed: 0, bubbled: 0 };
  if (!list.length) return { entries: list, stats };
  const byMember = mergeIndexByMember(view);
  if (!byMember.size) return { entries: list, stats }; // 库里没有合并节点：零成本直通

  // 合并节点自身（带 merge.members 的 claim）：它们的行**一律不单独出现**（规则 1）。
  const mergeNodeIds = new Set();
  for (const claim of Array.isArray(view?.claims) ? view.claims : []) {
    if (claim?.id && claim.merge && typeof claim.merge === 'object' && Array.isArray(claim.merge.members)) mergeNodeIds.add(claim.id);
  }

  // 每个合并节点：卡片里出现了它哪几个**成员**（成员 ≠ 合并节点自己）
  const groups = new Map();
  for (const entry of list) {
    const mergeClaim = entry?.claimId ? byMember.get(entry.claimId) : null;
    if (!mergeClaim) continue;
    const group = groups.get(mergeClaim.id) ?? { claim: mergeClaim, members: new Set() };
    group.members.add(entry.claimId);
    groups.set(mergeClaim.id, group);
  }
  // T226：本次命中的**合并组**数（按"组里有 ≥1 个成员成行"去重）——
  // 与 membersHit（行数）一起构成 组/行 两个分母；0 组表示这张卡上没有任何合并组被触发。
  stats.groupsHit = groups.size;

  const dropped = new Set();
  const replacement = new Map(); // 首个成员 id → 合并节点 entry（替换行）

  // 规则 2：**≥2 个成员**被命中 ⇒ 用合并节点替换这些成员行（多换 1，原行为不变）
  // 规则 2'（T207 触发面实验）：**只命中 1 个成员** ⇒ 也冒泡到合并节点（**1 换 1**，行数不变）
  for (const group of groups.values()) {
    const memberCount = group.members.size;
    stats.membersHit += memberCount;
    if (memberCount === 0) continue; // 规则 3：0 个成员 ⇒ 合并节点行不出现
    const entry = memberCount >= 2
      ? entryFromMergeNode(group.claim, options)
      : entryFromMergeBubble(group.claim, options);
    if (!entry) continue; // 造不出替代行 ⇒ 不动（宁可多一行，也不丢信息）
    for (const memberId of group.members) dropped.add(memberId);
    replacement.set([...group.members][0], entry);
    stats.collapsed += memberCount;
    if (memberCount === 1) stats.bubbled += 1;
  }
  // 规则 1：合并节点自己的行一律撤掉（它已由替换行代表，或本来就不该单独成行）
  for (const entry of list) {
    const id = entry?.claimId;
    if (id && mergeNodeIds.has(id)) dropped.add(id);
  }
  if (!dropped.size) return { entries: list, stats };

  const out = [];
  const placed = new Set();
  for (const entry of list) {
    if (entry?.claimId && dropped.has(entry.claimId)) {
      // 把合并节点插在它第一个成员的位置上（保持排序语义）
      const mergeEntry = replacement.get(entry.claimId);
      if (mergeEntry && !placed.has(mergeEntry.claimId)) {
        out.push(mergeEntry);
        placed.add(mergeEntry.claimId);
      }
      continue;
    }
    out.push(entry);
  }
  return { entries: out, stats };
}

// ---------------------------------------------------------------------------
// 记忆卡
// ---------------------------------------------------------------------------

export function renderIndexLine({ indexPath, scope, episodes }) {
  const n = Number.isFinite(episodes) ? episodes : 0;
  return `MEMORY: ${displayPath(indexPath)}（scope=${scope}, ${n} 局, 未列出≠不存在）`;
}

/** 路径渲染用正斜杠（跨机可读、和 scopeKey 的写法一致；不改真实路径）。 */
export function displayPath(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function renderEntryLine(entry, clip) {
  const body = clipLine(entry.rawText, clip);
  const flag = entry.crossScope ? ' [跨项目]' : '';
  // T345：F3 尾注放在**坐标之后**（正文仍是逐字原文，A6 文字层只核正文）。
  // 无 F3 的条目输出与旧版逐字节一致。
  const f3 = entry.f3?.when ? ` · ${entry.f3.when}${entry.f3.rule ? ` [${entry.f3.rule}]` : ''}` : '';
  return `- [${entry.marker}] ${body}${flag} (${entry.source.episode}, ${entry.date}, seq ${entry.source.seq})${f3}`;
}

function renderSection({ entries, beyond, droppedProvenance, limit, budgetTokens, clip, withMarkers = true, droppedCrossScope = 0, droppedUnknownScope = 0, scopeKey = null }) {
  const body = entries.map((e) => renderEntryLine(e, clip));
  const total = beyond + droppedProvenance + droppedCrossScope + droppedUnknownScope;
  if (total > 0) {
    const parts = [];
    if (beyond > 0) parts.push(`超出 ${limit} 条上限/预算 ${budgetTokens} tokens 的 ${beyond} 条`);
    if (droppedProvenance > 0) parts.push(`无源不入 ${droppedProvenance} 条（缺 occurredAt 或 seq）`);
    if (droppedCrossScope > 0) parts.push(`跨作用域未纳入 ${droppedCrossScope} 条 [scope=${scopeKey}]`);
    if (droppedUnknownScope > 0) parts.push(`作用域未知未纳入 ${droppedUnknownScope} 条`);
    body.push(`omitted: ${total} items（${parts.join(' · ')}）— see index.md（未列出 ≠ 不存在）`);
  }
  const head = withMarkers ? ['<memory-ledger>', MARKERS_LINE] : ['<memory-ledger>'];
  return [...head, ...body, '</memory-ledger>'].join('\n');
}

/** 降表示的阶梯（超预算按这个顺序降，绝不先丢日期与出处）。 */
const CLIP_STEPS = Object.freeze([TEXT_CLIP, TIGHT_CLIP]);

/**
 * 组装记忆卡。
 *
 * @param {object}   p
 * @param {object}   [p.signal]      §7.1 信号（只用于 shadow 记录，不参与渲染）
 * @param {object}   [p.walkResult]  R11 walk 结果：`{hits, path, omitted, tokens, depth?}`
 * @param {object}   [p.store]       R15 createStore() 返回对象（只读：list/counts/indexPath）
 * @param {string}   [p.scope]       scopeKey；缺省由 store/`w:<unknown>` 兜底
 * @param {number}   [p.now]         入卡时刻（只进 shadow 记录；卡片文本不含时钟，保证同输入同输出）
 * @param {number}   [p.limit]       条数上限（默认 5）
 * @param {number}   [p.budgetTokens] token 预算（默认 500；口径 = indexLine + section）
 * @param {string}   [p.indexPath]   覆盖 index 路径
 * @param {number}   [p.episodeCount] 覆盖「N 局」
 * @param {boolean}  [p.pointerTier] T3：三级交付的第二级开关（默认 = `POINTER_TIER_DEFAULT`）。
 *   `true` ⇒ `isPointerCandidate` 成立的条目只给指针（`episode + seq + occurredAt`），正文不渲染；
 *   `false` ⇒ 与 0.8.46 逐字节一致（A/B 对照与紧急回退）。
 * @returns {{indexLine:string, section:string|null, claims:Array, omissions:string|null,
 *            tokens:number, shadow:true, omittedCount:number, hitCount:number,
 *            indexTokens:number, limit:number, budgetTokens:number, cardVersion:number,
 *            tier:'content'|'pointers'|'abstain', pointerCount:number}}
 */
export function buildMemoryCard({
  cache = null,
  signal = null,
  walkResult = null,
  store = null,
  scope = null,
  now = null,
  // T298：preconditions 重跑回调（返回 true ⇒ 该 claim 可复活）。不传 ⇒ 一律不回活。
  preconditionOk = null,
  // T331：预计算的 `cost` 索引（claimId → 代价种类数）。不传 ⇒ 不过滤（fail-open）。
  costIndex = null,
  limit = ENTRY_LIMIT,
  budgetTokens = BUDGET_TOKENS,
  indexPath = null,
  episodeCount = null,
  droppedCrossScope = 0,
  droppedUnknownScope = 0,
  walkCrossScope = 0,
  preferenceHardOnly = false,
  allowCrossScopeClass = false,
  // T347：F3 上卡开关（默认开）。关掉 ⇒ 卡片与 0.6.3 之前的格式逐字节一致（A/B 对照用）。
  f3OnCard = true,
  // T3：**三级交付**的第二级开关（默认 = `POINTER_TIER_DEFAULT`，生产默认开）。
  // `true` ⇒ 没把握的条目只给指针（正文不渲染）；`false` ⇒ 输出与 0.8.46 逐字节一致
  // —— 这是"旧消费方不会炸"的唯一保证（A/B 对照走它）。
  pointerTier = POINTER_TIER_DEFAULT,
} = {}) {
  const crossScope = Number.isFinite(droppedCrossScope) && droppedCrossScope > 0 ? droppedCrossScope : 0;
  const unknownScope = Number.isFinite(droppedUnknownScope) && droppedUnknownScope > 0 ? droppedUnknownScope : 0;
  // walk 在遍历时拒掉的条数（R11 自己按作用域过滤的统计）：只作审计字段，不算"卡里少了几条"。
  const crossScopeWalk = Number.isFinite(walkCrossScope) && walkCrossScope > 0 ? walkCrossScope : 0;
  const view = storeView(store, cache);
  const sigIndex = store && typeof store.root === 'string' ? loadSignatureIndex(store.root) : null;
  const hits = Array.isArray(walkResult?.hits) ? walkResult.hits : [];
  const idxPath = indexPath ?? view.indexPath ?? 'memory-context/index.md';
  const episodes = Number.isFinite(episodeCount) ? episodeCount : view.episodeCount;
  const scopeKey = typeof scope === 'string' && scope
    ? scope
    : (typeof signal?.scopeKey === 'string' && signal.scopeKey ? signal.scopeKey : 'w:<unknown>');

  const indexLine = renderIndexLine({ indexPath: idxPath, scope: scopeKey, episodes });
  const indexTokens = estimateTokens(indexLine);

  // 兜底省略行：命中被作用域挡掉时，即使零展开也要说清"为什么什么都没有"。
  const scopeOmitted = crossScope + unknownScope + crossScopeWalk;
  const scopeOmissionText = scopeOmitted > 0
    ? `omitted: ${scopeOmitted} items（${[
      (crossScope + crossScopeWalk) > 0 ? `跨作用域未纳入 ${crossScope + crossScopeWalk} 条 [scope=${scopeKey}]` : null,
      unknownScope > 0 ? `作用域未知未纳入 ${unknownScope} 条` : null,
    ].filter(Boolean).join(' · ')}）— see index.md（未列出 ≠ 不存在）`
    : null;

  if (!hits.length) {
    // 不命中 ⇒ 零注入（只有首轮那一行事实）。
    return {
      indexLine,
      section: null,
      claims: [],
      omissions: scopeOmissionText,
      tokens: indexTokens,
      shadow: true,
      omittedCount: scopeOmitted,
      hitCount: 0,
      indexTokens,
      limit,
      budgetTokens,
      cardVersion: CARD_VERSION,
      crossScope,
      unknownScope,
      crossScopeWalk,
      signalAt: Number.isFinite(now) ? now : null,
      // T207/T226：不命中 ⇒ 四个计数全 0（字段始终存在）
      mergeStats: { groupsHit: 0, membersHit: 0, collapsed: 0, bubbled: 0 },
      // T3：不命中 = 无关 ⇒ abstain（三级里的第三级）
      tier: 'abstain',
      pointerCount: 0,
    };
  }

  const { entries: collectedEntries, dropped } = collectEntries({ hits, view, scope: scopeKey, preferenceHardOnly, signal, sigIndex, now, preconditionOk, costIndex, f3OnCard, pointerTier });
  // T162a：认「合并节点」。合流（consolidate）会把多条近似 claim 压成一个带 `merge.members` 的节点；
  // 消费侧不认它，合并节点与它的成员就会在同一张卡里重复出现。规则见 collapseMergeNodes 的注释。
  const { entries, stats: collapseStats } = collapseMergeNodes({
    entries: collectedEntries,
    view,
    options: { scope: scopeKey, episodesById: view.episodesById, signalTokens: signalTokensOf(signal) },
  });
  // T226：`candidatesHit` 已删除 —— T193 之后 walk 不再把合并节点当 hit 返回，
  // 那个计数**结构上永远 0**（AGENTS §2.4「指标先有消费者」）。改用 collapseMergeNodes 里
  // 由"卡片里出现该组的 ≥1 个成员"去重得到的 `groupsHit`（组数），它才会动。
  const mergeStats = { ...collapseStats };
  const sorted = entries.slice().sort(compareEntries);
  const droppedProvenance = dropped.noProvenance + dropped.noText;
  const droppedImperative = Number.isFinite(dropped.imperative) ? dropped.imperative : 0;

  // 取前缀并按「先降表示、后降条数」的阶梯收敛到预算内（方案 §7.2 纪律 3）：
  //   阶梯 1：文本 160 字 —— 完整表示
  //   阶梯 2：文本 60 字 —— 缩表示（日期 + ep + seq 一字不丢）
  //   阶梯 3：去掉 markers 说明行
  //   阶梯 4：从尾部丢条目（失败教训在前 ⇒ 丢的永远是最不重要的），并用 omitted 行显式声明。
  const maxTake = Math.min(limit, sorted.length);
  let chosen = [];
  let section = null;
  let beyond = 0;
  let clipUsed = TEXT_CLIP;

  outer: for (let take = maxTake; take >= 0; take -= 1) {
    const sel = sorted.slice(0, take);
    const rest = sorted.length - take;
    for (const clip of CLIP_STEPS) {
      for (const withMarkers of [true, false]) {
        const candidate = renderSection({
          entries: sel,
          beyond: rest,
          droppedProvenance,
          limit,
          budgetTokens,
          clip,
          withMarkers,
          droppedCrossScope: crossScope,
          droppedUnknownScope: unknownScope,
          scopeKey,
        });
        if (indexTokens + estimateTokens(candidate) <= budgetTokens) {
          chosen = sel;
          section = candidate;
          beyond = rest;
          clipUsed = clip;
          break outer;
        }
      }
    }
  }

  // 连空壳都放不进预算（预算小到不合理）⇒ 零展开，但**省略必须如实记数**（不许静默丢）。
  if (section === null) beyond = sorted.length;

  const omittedTotal = beyond + droppedProvenance + crossScope + unknownScope + droppedImperative;
  const omittedParts = [];
  if (beyond > 0) omittedParts.push(`超出 ${limit} 条上限/预算 ${budgetTokens} tokens 的 ${beyond} 条`);
  if (droppedProvenance > 0) omittedParts.push(`无源不入 ${droppedProvenance} 条（缺 occurredAt 或 seq）`);
  if (droppedImperative > 0) omittedParts.push(`含指令式片段未纳入 ${droppedImperative} 条（只丢该行，其余照常）`);
  if (crossScope > 0) omittedParts.push(`跨作用域未纳入 ${crossScope} 条 [scope=${scopeKey}]`);
  if (unknownScope > 0) omittedParts.push(`作用域未知未纳入 ${unknownScope} 条`);
  const omissions = omittedTotal > 0
    ? `omitted: ${omittedTotal} items（${omittedParts.join(' · ')}）— see index.md（未列出 ≠ 不存在）`
    : null;

  // 一条也渲染不出来（命中全是无源条目，或预算连空壳都放不下）⇒ 仍然零展开：
  // 不拿「omitted」空壳烧 token，但省略如实记在卡片的结构化字段里（shadow 记录与 CLI 都看得见）。
  if (!chosen.length) {
    return {
      indexLine,
      section: null,
      claims: [],
      omissions,
      tokens: indexTokens,
      shadow: true,
      omittedCount: omittedTotal,
      hitCount: hits.length,
      indexTokens,
      limit,
      budgetTokens,
      cardVersion: CARD_VERSION,
      crossScope,
      unknownScope,
      crossScopeWalk,
      signalAt: Number.isFinite(now) ? now : null,
      clip: clipUsed,
      // T207：命中过合并节点、但一行都没留下（成员全不可代表）⇒ 计数照实给出
      mergeStats,
      // T3：三级交付 —— 一行都没留下 ⇒ abstain（无关/无源/预算放不下，三者都不给）
      tier: 'abstain',
      pointerCount: 0,
    };
  }

  // T3：指针行的 `text` 是**那条记忆的正文**（相关性判定要用），但 `line` 是指针行 ——
  // 真正进模型上下文的只有 `section`（由 `line` 拼成），所以卡上不会出现没把握的断言。
  // content 行的 `text` 仍是渲染正文（与旧版一字不差）。
  const claims = chosen.map((e) => ({
    text: e.delivery === 'pointer' ? clipLine(e.claimText ?? '', TEXT_CLIP) : clipLine(e.rawText, clipUsed),
    kind: e.kind,
    marker: e.marker,
    state: e.state,
    occurredAt: e.occurredAt,
    date: e.date,
    source: e.source,
    line: renderEntryLine(e, clipUsed),
    ...(e.claimId ? { claimId: e.claimId } : {}),
    // T3：只在"只给指针"的行上出现（content 行结构一字不改，旧消费方不必判空）
    ...(e.delivery === 'pointer' ? { delivery: 'pointer' } : {}),
  }));
  const pointerCount = claims.filter((c) => c.delivery === 'pointer').length;

  return {
    indexLine,
    section,
    claims,
    omissions,
    tokens: indexTokens + estimateTokens(section ?? ''),
    shadow: true,
    omittedCount: omittedTotal,
    hitCount: hits.length,
    indexTokens,
    limit,
    budgetTokens,
    cardVersion: CARD_VERSION,
    crossScope,
    unknownScope,
    crossScopeWalk,
    signalAt: Number.isFinite(now) ? now : null,
    clip: clipUsed,
    // T207：触发面实验的运行时计数（只加字段，不改语义）
    mergeStats,
    // T3：三级交付的卡片级判定（content / pointers / abstain）与指针行数。
    // `tier` 由 `tierOf` 一处判定 —— 判定口径与消费方不各写一份。
    tier: tierOf({ section, claims }),
    pointerCount,
  };
}

// ---------------------------------------------------------------------------
// 降级 walk（R11 未落地时的等价物：词面命中 → 主题 → 棋局，深度 1）
// 只读 store；不写盘；命中 why 必填 —— 与 R11 同一份 hit 形态，R12 无需区分来源。
// ---------------------------------------------------------------------------

/**
 * @param {{signal:object, store:object, limit?:number}} p
 * @returns {{hits:Array, path:Array, omitted:{count:number,reason:string}, tokens:number,
 *            depth:number, degraded:true}}
 */
export function degradedWalk({ signal = null, store = null, limit = ENTRY_LIMIT, cache = null } = {}) {
  const view = storeView(store, cache);
  const needles = [];
  for (const t of Array.isArray(signal?.terms) ? signal.terms : []) {
    const s = String(t ?? '').trim().toLowerCase();
    if (s.length >= 2) needles.push(s);
  }
  for (const e of Array.isArray(signal?.entities) ? signal.entities : []) {
    const s = String(e?.key ?? '').trim().toLowerCase();
    if (s.length >= 2) needles.push(s);
  }

  const hits = [];
  const pathRows = [];
  const omitted = { count: 0, reason: '' };
  if (!needles.length || view.missing) {
    omitted.reason = needles.length ? 'store 不可读' : 'signal 无可用词条';
    return { hits, path: pathRows, omitted, tokens: 0, depth: 1, degraded: true };
  }

  let topicRecords = [];
  try {
    topicRecords = typeof store.list === 'function'
      ? (cache?.topics ?? store.list('topics').map((x) => x?.record)).filter((r) => r && typeof r.key === 'string')
      : [];
  } catch {
    topicRecords = [];
  }

  const matched = topicRecords
    .map((t) => {
      const key = t.key.toLowerCase();
      const hitNeedle = needles.find((n) => key === n || key.includes(n) || n.includes(key));
      return hitNeedle ? { topic: t, needle: hitNeedle } : null;
    })
    .filter(Boolean)
    .sort((a, b) => ((a.topic.df ?? 0) - (b.topic.df ?? 0)) || String(a.topic.key).localeCompare(String(b.topic.key)));

  if (!matched.length) {
    omitted.reason = '主题索引无命中';
    return { hits, path: pathRows, omitted, tokens: 0, depth: 1, degraded: true };
  }

  const seen = new Set();
  for (const { topic, needle } of matched.slice(0, 3)) {
    for (const epId of Array.isArray(topic.episodes) ? topic.episodes : []) {
      const rec = view.episodesById.get(epId) ?? null;
      const occurredAt = Number.isFinite(rec?.startedAt) ? rec.startedAt : (rec?.firstEventAt ?? null);
      const key = `${epId}\u0000${topic.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const failures = Number(rec?.signals?.failures ?? 0);
      hits.push({
        episode: epId,
        link: null,
        why: [topic.key],
        weight: 1 / Math.max(1, Number(topic.df) || 1),
        occurredAt: Number.isFinite(occurredAt) ? occurredAt : null,
        seq: Number.isFinite(rec?.closure?.seqFrom) ? rec.closure.seqFrom : null,
        kind: failures > 0 ? 'failure' : 'episode',
        depth: 1,
        needle,
        // 与 R11 walk 的 hit 同形态：带棋谱自己的 scopeKey，R12/R13 判作用域时用
        scopeKey: typeof rec?.scopeKey === 'string' ? rec.scopeKey : null,
      });
      pathRows.push({ from: signal?.kind ?? 'signal', to: topic.key, why: [topic.key] });
    }
  }

  hits.sort((a, b) => (rankOf(a.kind) - rankOf(b.kind))
    || ((b.occurredAt ?? 0) - (a.occurredAt ?? 0))
    || String(a.episode).localeCompare(String(b.episode))
    // T317：最后一级 = claimId 字典序（episode 指针没有 claimId，空串排前）—— 稳定排序的总序保证
    || String(a.claim ?? a.claimId ?? '').localeCompare(String(b.claim ?? b.claimId ?? '')));

  if (hits.length > limit) {
    omitted.count = hits.length - limit;
    omitted.reason = `超出 ${limit} 条`;
    hits.length = limit;
  }

  return {
    hits,
    path: pathRows.slice(0, 3),
    omitted,
    tokens: hits.reduce((s, h) => s + estimateTokens(`${h.episode} ${(h.why ?? []).join(' ')}`), 0),
    depth: 1,
    degraded: true,
  };
}

// ---------------------------------------------------------------------------
// shadow：只记录，不注入
// ---------------------------------------------------------------------------

/** shadow 目录的默认值（仓库内 evidence/shadow/，不是 <DSH_HOME>）。 */
export function defaultShadowDir() {
  return fileURLToPath(new URL(`../../${SHADOW_DIR_REL}/`, import.meta.url));
}

/**
 * 硬守卫：shadow 不得写进 `$DSH_HOME`（铁律：不写 <DSH_HOME>）。
 * 也不许写进 <DSH_HOME> 的 sessions / chess-context / memory-context（原件只读）。
 */
export function assertSafeShadowDir(dir, { dshHome = null } = {}) {
  const target = path.resolve(String(dir ?? ''));
  if (!dir || String(dir).trim() === '') {
    throw new InjectError('inject: writeShadow 需要 dir', 'inject/missing-dir');
  }
  const home = dshHome ?? process.env.DSH_HOME ?? null;
  if (!home) return target;
  const rel = path.relative(path.resolve(String(home)), target);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) {
    throw new InjectError(
      `inject: shadow 目录不得位于 $DSH_HOME 内（${target}）—— 影子模式只写仓库 evidence/shadow/`,
      'inject/shadow-in-dsh-home',
      { dir: target, dshHome: String(home) },
    );
  }
  return target;
}

/**
 * 追加一条 shadow 记录（JSONL）。**不注入**任何模型上下文，也不写 <DSH_HOME>。
 * @param {{dir?:string, card:object, signal?:object|null, at?:number|null, version?:number, dshHome?:string|null}} p
 */
export function writeShadow({ dir = null, card = null, signal = null, at = null, version = CARD_VERSION, dshHome = null } = {}) {
  if (!card || typeof card !== 'object') {
    throw new InjectError('inject: writeShadow 需要 card', 'inject/missing-card');
  }
  if (card.shadow !== true) {
    throw new InjectError('inject: writeShadow 只收 shadow 卡（card.shadow !== true 拒绝落记录）', 'inject/not-shadow');
  }
  const target = assertSafeShadowDir(dir ?? defaultShadowDir(), { dshHome });
  const when = Number.isFinite(at) ? at : Date.now();
  const record = {
    version: Number.isFinite(version) ? version : CARD_VERSION,
    mode: 'shadow',
    injected: false,
    at: when,
    atIso: new Date(when).toISOString(),
    signal: signal ?? null,
    card,
  };
  const file = path.join(target, SHADOW_FILE);
  fs.mkdirSync(target, { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  fs.appendFileSync(file, line, 'utf8');
  return { ok: true, path: file, dir: target, appended: 1, bytes: Buffer.byteLength(line, 'utf8') };
}

/** 读回 shadow 记录（坏尾不抛：崩溃截断的最后一行丢弃并计数）。 */
export function readShadow({ dir = null, limit = null } = {}) {
  const target = path.resolve(dir ?? defaultShadowDir());
  const file = path.join(target, SHADOW_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { records: [], parsed: 0, missing: true, path: file };
  }
  const records = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  const sliced = Number.isFinite(limit) && limit >= 0 ? records.slice(-limit) : records;
  return { records: sliced, parsed: records.length, badLines, missing: false, path: file };
}

// ---------------------------------------------------------------------------
// CLI：inject --shadow --signal "<文本>" [--store <dir>] [--json]
// ---------------------------------------------------------------------------

/** R11 walk 存在就用它（兼容 walkFromSignals / walk 两个导出名），缺失走降级。 */
async function loadWalkRoom() {
  try {
    const mod = await import('./walk.mjs');
    if (typeof mod?.walkFromSignals === 'function') return mod.walkFromSignals;
    if (typeof mod?.walk === 'function') return mod.walk;
    return null;
  } catch {
    return null;
  }
}

function formatInjectText({ card, gates, signal, walk, shadow }) {
  const lines = [];
  const gateOk = gates?.ok ? 'OK' : 'FAIL';
  // T3：只有真的出现指针行才多打这一段（没有指针行 ⇒ 输出与旧版逐字节一致）。
  const pointerCount = Number.isFinite(card.pointerCount) ? card.pointerCount : 0;
  const tierText = pointerCount > 0 ? ` · 交付 ${card.tier}（指针 ${pointerCount}/${card.claims.length}）` : '';
  lines.push(`inject · shadow=true（只记录，未注入模型上下文）· 命中 ${card.hitCount} · 渲染 ${card.claims.length} · tokens ${card.tokens}/${card.budgetTokens} · gates ${gateOk}${tierText}`);
  lines.push(`signal: kind=${signal.kind} · terms=${signal.terms.length} · entities=${signal.entities.length}${signal.terms.length ? ` · ${signal.terms.slice(0, 8).join(', ')}` : ''}`);
  const crossScope = Number.isFinite(card.crossScope) ? card.crossScope : 0;
  const crossScopeWalk = Number.isFinite(card.crossScopeWalk) ? card.crossScopeWalk : 0;
  const unknownScope = Number.isFinite(card.unknownScope) ? card.unknownScope : 0;
  const hitTotal = Number.isFinite(walk.hitCount) ? walk.hitCount : (walk.hits?.length ?? 0);
  const inScope = Array.isArray(walk.hits) ? walk.hits.length : 0;
  lines.push(`walk: ${walk.degraded ? '降级（R11 walk 未落地：词面命中 → 主题 → 棋局，深度 1）' : `R11 walk（深度 ${walk.depth ?? walk.maxDepth ?? '?'}）`} · 命中 ${hitTotal} · 同域 ${inScope}${(crossScope + crossScopeWalk) ? ` · 跨域已滤 ${crossScope + crossScopeWalk}` : ''}${unknownScope ? ` · 作用域未知 ${unknownScope}` : ''}`);
  lines.push('');
  lines.push(card.indexLine);
  if (card.section) {
    lines.push(card.section);
  } else {
    lines.push('（未命中：零展开；未列出 ≠ 不存在）');
  }
  lines.push('');
  if (shadow) lines.push(`shadow: ${shadow.path}（追加 ${shadow.appended} 行）`);
  else lines.push('shadow: 未写（加 --shadow 才落 evidence/shadow/）');
  if (gates?.ok) {
    const unver = Array.isArray(gates?.checks?.unverified) ? gates.checks.unverified : [];
    const unverText = unver.length ? ` · unverified ${unver.reduce((n, u) => n + (u.count ?? 0), 0)}（${[...new Set(unver.map((u) => `闸${u.gate}`))].join('/')}）` : '';
    lines.push(`gates: OK（10 道闸 + 边界：0 错${unverText}）`);
  } else {
    lines.push(`gates: FAIL（${gates?.errors?.length ?? 0} 错）`);
    for (const e of (gates?.errors ?? []).slice(0, 10)) lines.push(`  - [闸${e.gate}] ${e.code}: ${JSON.stringify(e.detail ?? null)}`);
  }
  return lines.join('\n');
}

/**
 * CLI 入口（由 src/rooms/cli.mjs 的 inject 分支调用；也可单测）。
 * @returns {Promise<{code:number, stdout:string, stderr:string, card?:object, gates?:object}>}
 */
export async function runInject({ flags = {}, positional = [], root = '' } = {}) {
  const storeRoot = path.resolve(String(flags.store ?? path.join(root || '.', 'memory-context')));
  if (!fs.existsSync(storeRoot)) {
    return { code: 2, stdout: '', stderr: `记忆库不存在：${storeRoot}（先跑 node scripts/archive.mjs --store <dir>）` };
  }

  const rawSignal = typeof flags.signal === 'string' && flags.signal !== '' ? flags.signal : (positional[0] ?? '');
  if (!String(rawSignal).trim()) {
    return { code: 2, stdout: '', stderr: '用法：inject --shadow --signal "<文本>" [--store <dir>] [--json]' };
  }

  const { createStore } = await import('./persist.mjs');
  const store = createStore({ root: storeRoot });

  const at = Date.now();
  const signal = signalFromText(rawSignal, { at, kind: typeof flags.kind === 'string' ? flags.kind : 'root-message' });
  signal.scopeKey = scopeKeyFromPath(process.cwd());
  const scope = signal.scopeKey;

  let walk = null;
  let walkError = null;
  const walkFn = await loadWalkRoom();
  if (walkFn) {
    try {
      // `scope` 一起传：R11 支持按作用域过滤时直接用；不支持时被忽略，由下面的 R12 侧过滤兜底。
      walk = walkFn({ signal, store, scope, depth: 2, limit: ENTRY_LIMIT, budgetTokens: BUDGET_TOKENS }) ?? null;
    } catch (err) {
      walkError = String(err?.message ?? err);
      walk = null;
    }
  }
  if (!walk) walk = degradedWalk({ signal, store, limit: ENTRY_LIMIT });

  // R12 侧兜底：证明不了在本域可见的命中一律不注入（方案 §4.10 默认不可见；闸 1 同判据）。
  const hitCountRaw = Array.isArray(walk.hits) ? walk.hits.length : 0;
  const scoped = filterHitsByScope(walk.hits ?? [], scope);
  // R11 若已按作用域过滤（它自己记在 dropped/omitted 里），R12 侧过滤就是兜底（通常为 0）；
  // 两边计数不重叠：walk 拒掉的根本没进 hits，所以不会和 scoped.dropped 重复。
  const walkDropped = walk?.dropped && typeof walk.dropped === 'object' ? walk.dropped : {};
  const walkCross = (Number.isFinite(walkDropped.crossScope) ? walkDropped.crossScope : 0)
    + (Number.isFinite(walkDropped.scopeMissing) ? walkDropped.scopeMissing : 0);

  // 之后一律用过滤后的 walk：hitCount 记过滤前的全量，hits 记真正会进卡的。
  walk = {
    ...walk,
    hitCount: hitCountRaw,
    hits: scoped.hits,
    crossScope: scoped.dropped,
    unknownScope: scoped.droppedUnknown,
    crossScopeWalk: walkCross,
  };

  const card = buildMemoryCard({
    signal,
    walkResult: walk,
    store,
    scope,
    now: at,
    droppedCrossScope: scoped.dropped,
    droppedUnknownScope: scoped.droppedUnknown,
    walkCrossScope: walkCross,
    // T3：`--pointer-tier` 打开三级交付的第二级（**生产默认已开**，见 `POINTER_TIER_DEFAULT`）；
    // `--no-pointer-tier` 显式回到两级 —— 它同时是 A/B 对照的入口：同一批输入跑两遍，
    // 比 `card.tokens` 与 `card.section` 的差。
    pointerTier: flags['no-pointer-tier'] === true ? false : POINTER_TIER_DEFAULT,
  });
  // store + scope 一起传：闸 1/2/3/4/5/7 才能真的核（否则只是 unverified）。
  const { runGates } = await import('./gates.mjs');
  const gates = runGates({ card, walkResult: walk, store, scope });

  let shadow = null;
  let shadowError = null;
  if (flags.shadow) {
    try {
      const dir = typeof flags['shadow-dir'] === 'string' && flags['shadow-dir']
        ? flags['shadow-dir']
        : defaultShadowDir();
      shadow = writeShadow({ dir, card, signal, at });
    } catch (err) {
      shadowError = String(err?.message ?? err);
    }
  }

  if (flags.json) {
    return {
      code: gates.ok && !shadowError ? 0 : 1,
      stdout: JSON.stringify({
        ok: gates.ok && !shadowError,
        scope: signal.scopeKey,
        signal,
        walk: {
          hits: walk.hits?.length ?? 0,
          hitTotal: Number.isFinite(walk.hitCount) ? walk.hitCount : (walk.hits?.length ?? 0),
          crossScope: Number.isFinite(walk.crossScope) ? walk.crossScope : 0,
          unknownScope: Number.isFinite(walk.unknownScope) ? walk.unknownScope : 0,
          crossScopeWalk: Number.isFinite(walk.crossScopeWalk) ? walk.crossScopeWalk : 0,
          depth: walk.depth ?? walk.maxDepth ?? null,
          degraded: Boolean(walk.degraded),
          error: walkError,
        },
        card,
        gates,
        shadow,
        shadowError,
      }, null, 2),
      stderr: shadowError ? `shadow 写入失败：${shadowError}` : '',
      card,
      gates,
    };
  }

  return {
    code: gates.ok && !shadowError ? 0 : 1,
    stdout: formatInjectText({ card, gates, signal, walk, shadow }),
    stderr: shadowError ? `shadow 写入失败：${shadowError}` : '',
    card,
    gates,
  };
}

export default {
  CARD_VERSION,
  ENTRY_LIMIT,
  BUDGET_TOKENS,
  INDEX_LINE_BUDGET,
  TEXT_CLIP,
  TIGHT_CLIP,
  IMPERATIVE_PATTERNS,
  GOVERNANCE_PATTERNS,
  PROVENANCE_LINE_RE,
  INDEX_LINE_RE,
  MARKERS_LINE,
  POINTER_SUPPORT_LIMIT,
  POINTER_TIER_DEFAULT,
  POINTER_BODY_RE,
  isPointerCandidate,
  pointerBodyOf,
  tierOf,
  InjectError,
  estimateTokens,
  formatCardDate,
  clipLine,
  singleLine,
  signalFromText,
  scopeKeyFromPath,
  renderIndexLine,
  displayPath,
  buildMemoryCard,
  degradedWalk,
  defaultShadowDir,
  assertSafeShadowDir,
  writeShadow,
  readShadow,
  runInject,
};
