#!/usr/bin/env node
// 注入卡片抽查（M4，2026-11-04；2026-11-04 二次升级：文字级判据）
//
// 读 <store>/card-samples.jsonl，逐条核对卡片里每个 (ep, seq)：
//   1) 引用层（旧判据，保留）：ep 存在 + seq 落在该局 closure 内 + ep 属于卡片 scope；
//   2) 文字层（新默认）：卡上那一段正文是否**真的出现在该局的事件文本里**，**四态**
//      （T239，docs/调研/46 三值逻辑：**未知 ≠ 已失效**）：
//        ok        —— 在该 seq ±window（默认 3）个事件内出现（旧键 textAtSeq / verdict 'at-seq'）；
//        offset    —— 原文在**同一局其它 seq** 命中（附 distance；旧键 textElsewhere / verdict 'elsewhere'）。
//                     distance ≤ 20 记 offsetNear（"指针偏了几个 seq"，T232/T238 实测占 not-substring 的 85%），
//                     > 20 记 offsetFar。**两类都不判红**，但单列 + 给占比 —— 它们是"待修项"，不是"坏引用"。
//        unreadable—— episode / 日志 / seq 读不到（旧实现混进 missing）。**单列：不进 A6 分子也不进分母**；
//                     退出码仍 fail-closed（没验过的不能当绿）。
//        notFound  —— 本局**任何 seq** 都找不到 ⇒ **真正的坏引用**（旧键 missing，保留兼容；文案改"真找不到"）。
//   3) 日期层：卡片日期必须等于所引 seq 附近那条事件的 occurredAt 格式化后的日期（UTC，口径同
//      `src/rooms/inject.mjs` 的 `formatCardDate`）。
//
// 退出码：文字层 missing > 0 或 日期不一致 > 0 ⇒ 1（旧的"可回溯 100% 就 exit 0"是假绿）。
// `--no-text` 退回弱判据（只查引用层），退出码也退回旧口径，留给对照/离线快跑。
//
// 只读，不写库，不写 <DSH_HOME> 之外的东西。
// 用法：node scripts/audit-card-samples.mjs [--store <dir>] [--json] [--no-text] [--window N]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { POINTER_BODY_RE, formatCardDate, singleLine } from '../src/rooms/inject.mjs';

/** 文字层默认窗口：实测「调用步 → 工具结果」的 seq 间隔直方为 0×9,2×9,3×2,4×30,5×11,6×6,8/9/10 各 1，
 *  取 ±3 会把一大批真引用判成 elsewhere（2026-11-04 audit-11 复核后定）。*/
export const DEFAULT_WINDOW = 10;

/** 卡片行的 provenance 尾巴：`(ep-xxxxxxxx, YYYY-MM-DD, seq N)`（日期字段也可能带时分）。 */
const PROV_SOURCE = /\((ep-[0-9a-f]{8}),\s*([^,]+),\s*seq\s*(\d+)\)/g;
/** 卡片行整体：`- [marker] 正文 (ep-…, 日期, seq N)`，可选 F3 尾注 ` · <当…不再成立> [rule]`。 */
// T345：F3 是**派生内容**（非逐字），必须落在坐标之后；正文组（第 2 组）仍是逐字原文，
// A6 文字层只核它。尾注可选 ⇒ 旧卡片行照常解析（组 6 为 undefined）。
const LINE_SOURCE = /^- \[([^\]]+)\] (.+) \((ep-[0-9a-f]{8}),\s*([^,]+),\s*seq\s*(\d+)\)(?: · (.+))?$/;

/** 取一个全新的 provenance 正则（避免 /g 的 lastIndex 串味）。 */
export function provRegex() {
  return new RegExp(PROV_SOURCE.source, PROV_SOURCE.flags);
}

/**
 * 把卡片里的正文归一成"可与事件原文 includes 比对"的形式：
 * 单行化（多空格/换行折成一个空格）→ 去掉卡片模板加的前缀（`[跨项目] `、`class:xxx · `）
 * → 去掉截断尾 `…` → 再单行化一次。CJK 与路径反斜杠都不做额外转义。
 */
export function normalizeCardText(text) {
  let s = singleLine(text);
  s = s.replace(/^\[跨项目\]\s*/, '');
  s = s.replace(/^class:[A-Za-z0-9._-]+\s*·\s*/, '');
  s = s.replace(/[…]+$/, '');
  return singleLine(s);
}

/** 从 section 里解析出每条渲染行的 { marker, text, episode, date, seq, falsifiableWhen }。 */
export function parseCardLines(section) {
  const out = [];
  for (const line of String(section ?? '').split('\n')) {
    const m = line.match(LINE_SOURCE);
    if (!m) continue;
    // T345：text 只取**逐字正文**（第 2 组）；F3 尾注单独给字段，绝不混进 text 参与 A6 比对。
    out.push({ marker: m[1], text: m[2], episode: m[3], date: m[4].trim(), seq: Number(m[5]), falsifiableWhen: m[6] ? m[6].trim() : null });
  }
  return out;
}

/**
 * T3 · **指针行的机械豁免**（A6 文字层）。
 *
 * 背景：三级交付（`content` / `pointers` / `abstain`）打开后，`observed` 且只有 1 局支撑的记忆
 * **只给坐标**（`episode + seq + occurredAt`），正文位置写的是计数 `N 局支撑 · 原文未给`。
 * 它**故意没有逐字正文** ⇒ 拿它回查事件原文必然记成 `notFound`（假红）。
 *
 * 判据（机械、可核；不是 `if (pointer) skip`）：
 *   ① 卡片行的正文（先剥掉卡片模板装饰 `[跨项目]`）**逐字等于** `pointerBodyOf` 的唯一产出形态
 *      —— `POINTER_BODY_RE` 与 `pointerBodyOf` 共用同一个尾段常量，产出的每个字都必须在判据里出现；
 *      判据是「等于」不是「包含」：少一个字符、多一个字符都不豁免。
 *   ② 该卡必须**自证**确有指针行：留样自带的 `row.pointerCount`（由 `appendCardSample` 从产出
 *      `section` 的**同一张卡对象**写入）必须等于本卡解析出的指针行数；对不上 ⇒ `pointerMismatch`
 *      （**fail-closed**：宁红，不静默跳过）。
 *   ③ 豁免只针对**正文层**：episode / seq / 日期三件套照常核（见 `auditRows` 的日期层）。
 *
 * 计入方式与 `unreadable` / `unresolved` 一致：**不进 A6 分子，也不进分母**
 * —— 它们是「没得核」，不是「核不过」。
 */
export function isPointerBody(text) {
  // 卡片模板装饰：行首 `[跨项目] ` 由 `normalizeCardText` 剥；`renderEntryLine` 的跨作用域标记在正文尾部。
  const body = normalizeCardText(text).replace(/\s*\[跨项目\]$/, '');
  return POINTER_BODY_RE.test(body);
}

/** 只要 provenance（兼容旧口径：不要求行首 marker 形态也能抽到 (ep, date, seq)）。 */
export function parseCardRefs(section) {
  return [...String(section ?? '').matchAll(provRegex())]
    .map((m) => ({ episode: m[1], date: m[2].trim(), seq: Number(m[3]) }));
}

/** 递归收集对象里的全部字符串（事件原文；不用 JSON.stringify，避免把 `"` 转义成 `\"`）。 */
export function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out); }
  return out;
}

/** 事件数组 → `[{ seq, time, blob }]`（blob 用换行拼接，正文不会跨两个字符串，故不会假阳）。 */
/** T239：`offset` 里"近偏移"的门槛（seq 距离）。≤ 这个值的算"指针偏了几个事件"，> 的算"远偏移"。 */
export const OFFSET_NEAR_MAX = 20;

/** T243：A6 的窗口 —— `support.quote` 必须落在声明 seq 的 ±4 内（T232 的 P2 口径）。 */
export const QUOTE_WINDOW = 4;

/**
 * T243：原文归一化规则（**判据的一部分，必须可复现**）：
 *   ① 全角空格/NBSP（U+00A0、U+3000）→ 普通空格；
 *   ② CRLF / CR → LF；
 *   ③ 连续空白折叠成一个空格；首尾去空白。
 * 目的：卡片正文与事件原文的差异里，"空白被折叠"这一类（T238）不该算 notFound。
 */
export function normalizeForQuote(s) {
  return String(s ?? '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把 claims 建成 `ep#seq → [{claimId, quote}]` 索引：A6 靠"卡片行的 (ep, seq)"反查它属于哪条 claim，
 * 再用该 claim 的 `support.quote` 去核原文（而不是拿渲染正文）。
 */
export function buildQuoteIndex(claims = []) {
  const index = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    const id = typeof claim?.id === 'string' ? claim.id : null;
    if (!id) continue;
    for (const sup of Array.isArray(claim.support) ? claim.support : []) {
      const ep = typeof sup?.episode === 'string' ? sup.episode : null;
      const seq = Number(sup?.seq);
      if (!ep || !Number.isFinite(seq)) continue;
      const key = `${ep}#${seq}`;
      const list = index.get(key) ?? [];
      list.push({ claimId: id, quote: typeof sup?.quote === 'string' ? sup.quote : '' });
      index.set(key, list);
    }
  }
  return index;
}

export function eventsToBlobs(events) {
  return (Array.isArray(events) ? events : [])
    .map((ev) => ({
      seq: Number(ev?.seq),
      time: Number.isFinite(ev?.time) ? Number(ev.time) : null,
      // 每个字符串先 singleLine：多行错误原文（含换行/缩进）不归一的话，卡片正文（已单行化）会假阳成 missing。
      // 不同字符串之间用换行分隔 —— 一条正文不会跨两个字符串，所以拼接不会制造假阳。
      blob: collectStrings(ev?.data ?? ev ?? {}).map((s) => singleLine(s)).filter(Boolean).join('\n'),
      // 2026-11-04（0.132.0）：抽取会把同一事件里的**多段字符串**拼成一行（如 stdout+stderr），
      // 单行化后段间只剩一个空格，而 blob 用换行连接 ⇒ 会假阳成 missing。这里并存一份空格连接的版本，
      // 只用来把这类拼接单独记成 joined（**不冒充 at-seq**，汇总里单独报数）。
      blobJoined: collectStrings(ev?.data ?? ev ?? {}).map((s) => singleLine(s)).filter(Boolean).join(' '),
    }))
    .filter((ev) => Number.isFinite(ev.seq));
}

/** 文字层三档判定。events 需为 `eventsToBlobs()` 的形状。 */
export function classifyTextByEvents({ text, seq, events, window = DEFAULT_WINDOW }) {
  const needle = normalizeCardText(text);
  if (!needle) return { verdict: 'missing', nearestSeq: null, distance: null };
  let best = null;
  for (const ev of events) {
    if (!ev.blob.includes(needle)) continue;
    const distance = Math.abs(Number(ev.seq) - Number(seq));
    if (!best || distance < best.distance) best = { nearestSeq: ev.seq, distance };
  }
  if (!best) {
    // 严格版没命中 ⇒ 看空格拼接版：命中的话记 joined（同一局里的片段被拼成一行），不冒充 at-seq
    for (const ev of events) {
      const joined = ev.blobJoined ?? '';
      if (!joined || !joined.includes(needle)) continue;
      const distance = Math.abs(Number(ev.seq) - Number(seq));
      if (!best || distance < best.distance) best = { nearestSeq: ev.seq, distance, joined: true };
    }
    if (!best) return { verdict: 'missing', nearestSeq: null, distance: null };
    return { verdict: 'joined', nearestSeq: best.nearestSeq, distance: best.distance };
  }
  return {
    verdict: best.distance <= Math.max(0, Number(window) || 0) ? 'at-seq' : 'elsewhere',
    nearestSeq: best.nearestSeq,
    distance: best.distance,
  };
}

/** 找 seq 处的事件；没有就退到最近的一条（日期层用）。 */
export function eventNearSeq(events, seq) {
  let exact = null;
  let best = null;
  for (const ev of events) {
    const d = Math.abs(Number(ev.seq) - Number(seq));
    if (d === 0) { exact = ev; break; }
    if (!best || d < best.d) best = { d, ev };
  }
  return exact ?? best?.ev ?? null;
}

/** 日期层：卡片日期（取前 10 位）与事件的 UTC 日期比较。 */
export function checkDate({ refDate, event }) {
  const day = String(refDate ?? '').trim().slice(0, 10);
  if (!event || !Number.isFinite(event.time)) return { verdict: 'no-event', eventDate: null };
  const eventDate = formatCardDate(event.time);
  return { verdict: eventDate === day ? 'ok' : 'mismatch', eventDate };
}

/**
 * 主判定（纯逻辑，事件读取用 `loadEvents` 注入，便于测试）。
 *
 * @param {object}   p
 * @param {Array}    p.rows          card-samples.jsonl 的行
 * @param {Map}      p.episodes      id → episode 记录
 * @param {Function} [p.loadEvents]  `async (episodeId, episodeRecord) => events[]`（原始事件数组）
 * @param {number}   [p.window]      文字层 at-seq 的窗口（事件条数），默认 3
 * @param {boolean}  [p.textCheck]   默认 true；false ⇒ 只跑引用层（`--no-text`）
 */
export async function auditRows({ rows, episodes, loadEvents = null, window = DEFAULT_WINDOW, textCheck = true, claims = null, quoteWindow = QUOTE_WINDOW } = {}) {
  // T243：给了 claims 就走**新口径**（support.quote 判定）；没给则退回旧口径（渲染正文），
  // 只为兼容既有调用方/测试 —— CLI 永远传 claims。
  const quoteIndex = claims ? buildQuoteIndex(claims) : null;
  const mode = quoteIndex ? 'quote' : 'text';
  const cache = new Map();
  const eventsOf = async (id) => {
    if (!textCheck || typeof loadEvents !== 'function') return null;
    if (!cache.has(id)) {
      let raw = [];
      try { raw = (await loadEvents(id, episodes.get(id) ?? null)) ?? []; } catch { raw = null; }
      cache.set(id, raw === null ? null : eventsToBlobs(raw));
    }
    return cache.get(id);
  };

  const details = [];
  for (const row of rows) {
    const lines = parseCardLines(row?.section);
    const refs = lines.length ? lines : parseCardRefs(row?.section).map((r) => ({ ...r, text: '', marker: '' }));
    const verdicts = [];
    for (const ref of refs) {
      const ep = episodes.get(ref.episode);
      const inRange = ep ? ref.seq >= (ep.closure?.seqFrom ?? 0) && ref.seq <= (ep.closure?.seqTo ?? 0) : false;
      const sameScope = ep ? ep.scopeKey === row.scope : false;
      const base = { episode: ref.episode, seq: ref.seq, date: ref.date, exists: Boolean(ep), inRange, sameScope };
      if (!textCheck || !ref.text) {
        verdicts.push({ ...base, verdict: 'skipped', nearestSeq: null, distance: null, dateVerdict: 'skipped', eventDate: null });
        continue;
      }
      const events = await eventsOf(ref.episode);
      if (events === null) {
        // T239：读不到原件（日志缺失/解析失败）⇒ **单列成 unreadable**，不再冒充 missing。
        // 为什么：missing 的语义是"该局任何 seq 都没有这段文字"（内容对不上），而这里是"根本没读到"——
        // 两者是完全不同的两类问题（docs/调研/46：未知 ≠ 已失效）。unreadable 不进 A6 分子/分母，
        // 但退出码仍 fail-closed（一次全 unreadable 的审计必须非 0，否则就是"没验过也报绿"）。
        verdicts.push({ ...base, verdict: 'unreadable', state: 'unreadable', nearestSeq: null, distance: null, dateVerdict: 'unreadable', eventDate: null });
        continue;
      }
      const dateVerdict = checkDate({ refDate: ref.date, event: eventNearSeq(events, ref.seq) });
      // T3 · 三级交付：指针行**故意没有逐字正文**（正文位置只有计数）⇒ 正文层单列 `pointer`，
      // 既不进 A6 分子也不进分母（与 unreadable / unresolved 同类：**没得核**，不是核不过）。
      // 坐标与日期**照常核**（豁免只针对正文层）；是否该豁免由 `isPointerBody` 一处判定。
      if (isPointerBody(ref.text)) {
        verdicts.push({ ...base, verdict: 'pointer', state: 'pointer', nearestSeq: null, distance: null, claimId: null, textTrace: 'skipped', dateVerdict: dateVerdict.verdict, eventDate: dateVerdict.eventDate });
        continue;
      }
      // 信息项（不参与 A6）：渲染正文的旧检查 —— 仍有用（能发现"命中处是另一张被注入过的卡"）。
      const textTrace = ref.text ? classifyTextByEvents({ text: ref.text, seq: ref.seq, events, window }).verdict : 'skipped';
      // T243 主判据：用 claim 的 support.quote 去核原文（窗口 ±4）
      let textVerdict;
      let resolvedClaimId = null;
      if (quoteIndex) {
        const candidates = quoteIndex.get(`${ref.episode}#${ref.seq}`) ?? [];
        if (!candidates.length) {
          // 反查不到 claimId ⇒ 单列 unresolved（不进分子分母，fail-closed 由汇总层决定）
          textVerdict = { verdict: 'unresolved', state: 'unresolved', nearestSeq: null, distance: null, quote: null };
        } else {
          // 同一条 (ep, seq) 可能被多条 claim 引用：优先取"quote 在 ±window 内能命中"的那条
          let picked = null;
          for (const cand of candidates) {
            const quote = normalizeForQuote(cand.quote);
            if (!quote) continue;
            const v = classifyTextByEvents({ text: quote, seq: ref.seq, events, window: quoteWindow });
            if (v.verdict === 'at-seq') { picked = { cand, v, quote }; break; }
            if (!picked) picked = { cand, v, quote };
          }
          if (!picked) {
            textVerdict = { verdict: 'unresolved', state: 'unresolved', nearestSeq: null, distance: null, quote: null };
          } else {
            resolvedClaimId = picked.cand.claimId;
            // at-seq → ok；elsewhere → offset；missing → notFound（四态）
            const mapped = picked.v.verdict === 'at-seq' ? 'ok'
              : (picked.v.verdict === 'elsewhere' ? 'offset'
                : (picked.v.verdict === 'missing' ? 'notFound' : picked.v.verdict));
            textVerdict = { verdict: mapped, state: mapped, nearestSeq: picked.v.nearestSeq, distance: picked.v.distance, quote: picked.quote };
          }
        }
      } else {
        const old = classifyTextByEvents({ text: ref.text, seq: ref.seq, events, window });
        const mapped = old.verdict === 'at-seq' ? 'ok'
          : (old.verdict === 'elsewhere' ? 'offset'
            : (old.verdict === 'missing' ? 'notFound' : old.verdict));
        textVerdict = { verdict: old.verdict, state: mapped, nearestSeq: old.nearestSeq, distance: old.distance, quote: null };
      }
      verdicts.push({ ...base, ...textVerdict, claimId: resolvedClaimId, textTrace, dateVerdict: dateVerdict.verdict, eventDate: dateVerdict.eventDate });
    }
    const count = (pred) => verdicts.filter(pred).length;
    // T3：豁免必须**自证**（留样的 `pointerCount` / `tier` 来自产出 `section` 的**同一张卡对象**）：
    //   ① 声明了 `pointerCount` ⇒ 必须等于本卡解析出的指针行数（多一条少一条都是判据坏了 ⇒ 红）；
    //   ② 卡片级 `tier` 与解析结果必须一致（`pointers` ⇔ 每一行都是指针；`content` ⇔ 至少一行有正文）⇒ 红；
    //   ③ **没有** `pointerCount` 的留样（离线重抽路径 `scripts/a6-text-level.mjs` 自己造行，不带该字段）
    //      ⇒ 记 `pointerUnverified`（**信息项**，不红）：正文判据（①）仍然生效，
    //      "这张卡有几条指针行"由造行者从 `card.pointerCount` 自证；不拿"缺字段"冒充"判据通过"。
    // 为什么 ③ 不 fail-closed：那是**造行方的字段缺失**，不是卡坏了；把离线路径判红换不来任何召回，
    // 只会制造一条没人能修的假红（与 T239「unreadable 不冒充 missing」同一条纪律：**未知 ≠ 已失效**）。
    // `--no-text` 时文字层整层跳过（不解析指针），三项都不做（与"文字层已跳过"同口径）。
    const pointerLines = textCheck ? count((v) => v.state === 'pointer') : 0;
    const declaredPointer = typeof row?.pointerCount === 'number' && Number.isFinite(row.pointerCount) ? Number(row.pointerCount) : null;
    const declaredTier = typeof row?.tier === 'string' ? row.tier : null;
    const allPointers = verdicts.length > 0 && pointerLines === verdicts.length;
    const pointerMismatch = textCheck && declaredPointer !== null && pointerLines > 0 && declaredPointer !== pointerLines;
    const pointerUnverified = textCheck && declaredPointer === null && pointerLines > 0;
    const tierMismatch = textCheck && (declaredTier === 'pointers' ? !allPointers : (declaredTier === 'content' ? allPointers : false));
    details.push({
      at: row.at,
      digest: row.digest,
      tokens: row.tokens,
      scope: row.scope,
      refs: verdicts.length,
      ok: count((v) => v.exists && v.inRange),
      sameScope: count((v) => v.sameScope),
      bad: verdicts.filter((v) => !v.exists || !v.inRange).slice(0, 3),
      // T239/T243 四态（旧键全部保留，兼容下游读法）
      textOk: count((v) => v.state === 'ok'),
      textAtSeq: count((v) => v.state === 'ok'),
      textOffset: count((v) => v.state === 'offset'),
      textElsewhere: count((v) => v.state === 'offset'),
      textOffsetNear: count((v) => v.state === 'offset' && Number.isFinite(v.distance) && v.distance <= OFFSET_NEAR_MAX),
      textOffsetFar: count((v) => v.state === 'offset' && Number.isFinite(v.distance) && v.distance > OFFSET_NEAR_MAX),
      textNotFound: count((v) => v.state === 'notFound'),
      textMissing: count((v) => v.state === 'notFound'), // 旧键 = notFound（true 坏引用）
      textUnreadable: count((v) => v.state === 'unreadable'),
      textUnresolved: count((v) => v.state === 'unresolved'),
      // T3：指针行（正文未给）—— 单独计数，不进 A6 分子分母；`*Mismatch` 是自证失败（红）
      textPointer: pointerLines,
      pointerMismatch,
      pointerUnverified,
      tierMismatch,
      textJoined: count((v) => v.verdict === 'joined'),
      // 信息项（不参与 A6）：渲染正文的旧检查
      traceOk: count((v) => v.textTrace === 'at-seq'),
      traceOffset: count((v) => v.textTrace === 'elsewhere'),
      traceNotFound: count((v) => v.textTrace === 'missing'),
      dateOk: count((v) => v.dateVerdict === 'ok'),
      dateBad: count((v) => v.dateVerdict === 'mismatch' || v.dateVerdict === 'no-event'),
      verdicts,
    });
  }

  const sum = (key) => details.reduce((n, d) => n + d[key], 0);
  const totalRefs = sum('refs');
  const okRefs = sum('ok');
  const sameScopeRefs = sum('sameScope');
  const textCheckFailed = textCheck;
  // T239：A6 的分母 = 引用数 − 读不到的（unreadable 不进分子也不进分母）。
  const textUnreadable = sum('textUnreadable');
  const textUnresolved = sum('textUnresolved');
  // T3：指针行同样**没得核**（正文未给是设计，不是坏引用）⇒ 与 unreadable/unresolved 一样两头都不计。
  const textPointer = sum('textPointer');
  const pointerMismatchCards = details.filter((d) => d.pointerMismatch || d.tierMismatch).length;
  const pointerUnverifiedCards = details.filter((d) => d.pointerUnverified).length;
  // T243：unverified 类（读不到 / 反查不到 / 只有指针）都不进 A6 分子分母
  const a6Denominator = totalRefs - textUnreadable - textUnresolved - textPointer;
  // 中位距离：只统计"偏移命中"（offset）的那批；偶数个取中间两个的均值。
  const offsetDistances = details
    .flatMap((d) => d.verdicts)
    .filter((v) => v.state === 'offset' && Number.isFinite(v.distance))
    .map((v) => Number(v.distance))
    .sort((a, b) => a - b);
  const medianOf = (arr) => {
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  };
  return {
    samples: details.length,
    refs: totalRefs,
    okRefs,
    traceableRate: totalRefs ? okRefs / totalRefs : null,
    sameScopeRefs,
    crossScopeRefs: totalRefs - sameScopeRefs,
    // 四态（旧键保留）
    textOk: sum('textOk'),
    textAtSeq: sum('textAtSeq'),
    textOffset: sum('textOffset'),
    textElsewhere: sum('textElsewhere'),
    textOffsetNear: sum('textOffsetNear'),
    textOffsetFar: sum('textOffsetFar'),
    textNotFound: sum('textNotFound'),
    textMissing: sum('textMissing'), // = textNotFound（真找不到）
    textUnreadable,
    textUnresolved,
    // T3：指针行（正文未给，设计如此）—— 单列 + 自证失败/未自证计数；都不进 A6 分子分母（指针另有自证闸）
    textPointer,
    pointerMismatchCards,
    pointerUnverifiedCards,
    a6Mode: mode,
    textJoined: sum('textJoined'),
    // 信息项：旧口径（渲染正文）在同一批样本上的读数，便于对照
    traceOk: sum('traceOk'),
    traceOffset: sum('traceOffset'),
    traceNotFound: sum('traceNotFound'),
    a6Denominator,
    textOffsetRatio: a6Denominator ? sum('textOffset') / a6Denominator : null,
    textNotFoundRatio: a6Denominator ? sum('textNotFound') / a6Denominator : null,
    offsetDistanceMedian: medianOf(offsetDistances),
    dateOk: sum('dateOk'),
    dateBad: sum('dateBad'),
    textCheck,
    window,
    details,
    // 退出码判据（语义不变 + T239 明确）：
    //   · notFound（真坏引用）> 0 ⇒ 红；
    //   · unreadable（核不了）> 0 ⇒ 红 —— fail-closed：一次"全读不到"的审计必须是红的，否则就是没验过也报绿；
    //   · offset（指针偏了）**不红**，只在汇总里单列 + 给占比（待修项）；
    //   · 日期不一致 ⇒ 红；--no-text 退回旧口径；
    //   · T3：指针行（`isPointerBody`）**不红**（正文未给是设计），但它的**自证**对不上 ⇒ 红（fail-closed）。
    exitCode: textCheckFailed
      ? ((sum('textNotFound') > 0 || textUnreadable > 0 || textUnresolved > 0 || sum('dateBad') > 0 || pointerMismatchCards > 0) ? 1 : 0)
      : (okRefs === totalRefs ? 0 : 1),
  };
}

/** 读某个 episode 的原始事件（逐帧解，口径同 `src/rooms/cli.mjs` 的 `readSession`）。 */
export function makeLogLoader({ home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home' } = {}) {
  return async (episodeId, ep) => {
    const logPath = ep?.closure?.logPath;
    if (!logPath) return [];
    const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
    if (!fs.existsSync(abs)) return [];
    const buf = fs.readFileSync(abs);
    const framesRes = readFrames(buf);
    const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
    const parsed = parseEvents(frames ?? []);
    return parsed?.events ?? [];
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 从 `live-stats.jsonl` 的行里挑出**当前宿主**（最后一条心跳所在的那个 pid）。
 * 2026-11-04：重启前后新旧进程混写 `card-samples.jsonl`，全量统计会把旧代码的账算成"回归"
 * （A5 那 2 条跨作用域、A6 那 17 条 missing 都是 0.117.0 产出的）。`--current` 用这个函数自动切。
 * 纯函数：不读盘，单测直接喂行。
 */
export function pickCurrentPid(liveRows, { nowMs = null } = {}) {
  const rows = (Array.isArray(liveRows) ? liveRows : []).filter((r) => r && Number.isFinite(Number(r.pid)) && Number.isFinite(Number(r.at)));
  if (!rows.length) return null;
  let latest = rows[0];
  for (const r of rows) if (Number(r.at) > Number(latest.at)) latest = r;
  const pid = Number(latest.pid);
  const at = Number(latest.at);
  const ageMs = Number.isFinite(nowMs) ? Math.max(0, nowMs - at) : null;
  const stale = Number.isFinite(ageMs) ? ageMs > 30 * 60 * 1000 : false;
  const count = rows.filter((r) => Number(r.pid) === pid).length;
  return { pid, at, ageMs, stale, count };
}

async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
  const file = path.join(storeRoot, 'card-samples.jsonl');
  if (!fs.existsSync(file)) { console.error(`没有抽样文件：${file}`); return 2; }

  const textCheck = !argv.includes('--no-text');
  const window = Number(opt('window', String(DEFAULT_WINDOW)));
  const store = createStore({ root: storeRoot });
  // T243：A6 需要 claim 的 support.quote 才能核原文（拿渲染正文去追原文恒失败）
  let claimsForAudit = [];
  try { claimsForAudit = store.list('claims').map((e) => e?.record).filter(Boolean); } catch { claimsForAudit = []; }
  const episodes = new Map(store.list('episodes').map((x) => [x.record.id, x.record]));
  let rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  // 2026-11-04：按宿主进程切样本（重启前后新旧代码混写同一文件，混在一起会把旧账读成回归）。
  //   --pid <n>   显式指定；
  //   --current   自动挑"最后一条心跳所在的 pid"（巡检用这个，省得每次手抄 pid）。
  let pidWant = Number(opt('pid', '0'));
  let pidNote = '';
  if (!(Number.isFinite(pidWant) && pidWant > 0) && argv.includes('--current')) {
    const liveFile = path.join(storeRoot, 'live-stats.jsonl');
    const live = fs.existsSync(liveFile)
      ? fs.readFileSync(liveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const cur = pickCurrentPid(live, { nowMs: Date.now() });
    if (cur) {
      pidWant = cur.pid;
      const mins = cur.ageMs == null ? '?' : Math.round(cur.ageMs / 60000);
      pidNote = `（--current ⇒ 宿主 pid=${cur.pid}，最后心跳 ${mins} 分钟前${cur.stale ? '，**看起来没在跑**' : ''}；该进程心跳 ${cur.count} 条）`;
    } else {
      pidNote = '（--current 没找到心跳记录 ⇒ 退回全量样本）';
    }
  }
  if (Number.isFinite(pidWant) && pidWant > 0) rows = rows.filter((r) => Number(r.pid) === pidWant);
  if (argv.includes('--current') && rows.length === 0 && pidNote !== '') {
    pidNote += ' · 该进程还没有带 pid 的样本（重启后新写的样本才会带）';
  }

  const out = await auditRows({ rows, episodes, loadEvents: makeLogLoader({ home: HOME }), window, textCheck, claims: claimsForAudit });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const pct = (n) => (out.refs ? `${((n / out.refs) * 100).toFixed(1)}%` : '-');
    if (textCheck) {
      // T239：四态分列（ok / offset / unreadable / notFound）+ 中位距离 + 占比
      const ratio = (n) => (out.a6Denominator ? `${((n / out.a6Denominator) * 100).toFixed(1)}%` : '-');
      console.log(`样本 ${out.samples} 张 · 引用 ${out.refs} 条 · A6 分母 ${out.a6Denominator}（= 引用 − unreadable ${out.textUnreadable} − unresolved ${out.textUnresolved} − 指针 ${out.textPointer}）`);
      console.log(`  ok ${out.textOk} · offset ${out.textOffset}（近 ${out.textOffsetNear} / 远 ${out.textOffsetFar}，占比 ${ratio(out.textOffset)}，中位距离 ${out.offsetDistanceMedian ?? 'n/a'}）· unreadable ${out.textUnreadable} · notFound ${out.textNotFound}（真找不到，占比 ${ratio(out.textNotFound)}）· unresolved ${out.textUnresolved} · 指针 ${out.textPointer}（正文未给，不计入 A6）· 日期一致 ${out.dateOk}/${out.refs}${pidNote ? ' ' + pidNote : ''}`);
      console.log(`  A6 口径：${out.a6Mode === 'quote' ? `support.quote（±${QUOTE_WINDOW}，NBSP/CRLF 归一）` : '渲染正文（旧口径）'} · 分母 ${out.a6Denominator} = 引用 − unreadable ${out.textUnreadable} − unresolved ${out.textUnresolved} − 指针 ${out.textPointer}${out.pointerMismatchCards ? ` · **指针自证失败 ${out.pointerMismatchCards} 张**（pointerCount/tier 与解析结果对不上）` : ''}${out.pointerUnverifiedCards ? ` · 指针未自证 ${out.pointerUnverifiedCards} 张（留样没有 pointerCount：离线重抽路径）` : ''}`);
      console.log(`  对照（信息项，不参与 A6）：渲染正文口径 ok ${out.traceOk} · offset ${out.traceOffset} · notFound ${out.traceNotFound}`);
      console.log(`（引用层：可回溯 ${out.okRefs}/${out.refs}（${pct(out.okRefs)}，弱判据）· 同作用域 ${out.sameScopeRefs} · 跨作用域 ${out.crossScopeRefs} · window=±${out.window}）`);
      const gap = out.details.flatMap((d) => d.verdicts)
        .filter((v) => v.distance != null && v.distance > out.window && v.distance <= 10).length;
      if (gap > 0) {
        console.log(`（提示：另有 ${gap} 条落在 ±${out.window + 1}~±10 —— 这是"调用步 → 工具结果"的自然间隔，不是错位；可用 --window 10 复核）`);
      }
    } else {
      console.log(`样本 ${out.samples} 张 · 引用 ${out.refs} 条 · 可回溯 ${out.okRefs}（${pct(out.okRefs)}）· 同作用域 ${out.sameScopeRefs} · 跨作用域 ${out.crossScopeRefs} · 文字层已跳过（--no-text）${pidNote ? ' ' + pidNote : ''}`);
    }
    for (const d of out.details) {
      const extra = textCheck
        ? ` ok=${d.textOk} offset=${d.textOffset} unreadable=${d.textUnreadable} notFound=${d.textNotFound} unresolved=${d.textUnresolved} pointer=${d.textPointer} 日期ok=${d.dateOk}/${d.refs}`
        : '';
      console.log(`- ${new Date(d.at).toLocaleString()} ${String(d.scope).slice(-24)} tokens=${d.tokens} refs=${d.refs} ok=${d.ok}${extra}`);
    }
  }
  return out.exitCode;
}

const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => { console.error(`审计失败：${String(error?.message ?? error)}`); process.exit(2); });
}
