// T345 · F3 失效条件上卡（派生内容与逐字正文严格分离）
//   卡片行：`- [marker] <逐字正文> (ep-…, 日期, seq N) · <当…不再成立> [rule]`
//   A6 文字层只核**逐字正文**（第 2 组）；F3 尾注若混进正文 ⇒ 整条会报 missing。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';
import { buildMemoryCard, F3_MAX_CHARS } from '../src/rooms/inject.mjs';
import { parseCardLines } from '../scripts/audit-card-samples.mjs';

const T0 = 1_700_000_000_000;
const T = (day) => T0 + day * 86_400_000;
const SCOPE = 'w:d:/work/demo';
const QUOTE = 'Error: Cannot find module "/d/ws/src/app.mjs"';

function makeStore(withF3, { when } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 't345-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [{
    id: 'ep-aaaaaaa1', sessionId: 'session-aaaaaaa1', scopeKey: SCOPE,
    startedAt: T(21), endedAt: T(21) + 3_600_000, firstEventAt: T(21), lastEventAt: T(21) + 3_600_000,
    recordedAt: null,
    closure: { logPath: 'sessions/demo/x/session.v4.jsonl.zstd', graphPath: 'graphs/x/graph.json', seqFrom: 11, seqTo: 99 },
    l0: '', signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    threadIds: [], state: 'archived',
  }]);
  store.putMany('claims', [{
    id: 'c-0000f301', kind: 'antipattern', text: QUOTE, scopeKey: SCOPE, threadIds: [], state: 'observed',
    // T3（三级交付）：**有把握 = 支撑 ≥ 2 局**。只有 1 局支撑的 `observed` 记在三级交付里**只给指针**
    // （正文不渲染、也不带 F3 尾注）—— 本文件测的是 F3 的渲染与解析，必须用「有把握」的夹具，
    // 否则测到的就不是 F3，而是"这一级现在归指针管"。
    support: [
      { episode: 'ep-aaaaaaa1', seq: 41, quote: QUOTE, occurredAt: T(21) },
      { episode: 'ep-aaaaaaa1', seq: 40, quote: 'Error: another sighting of the same shape', occurredAt: T(21) },
    ],
    counter: [], validity: { type: 'none', value: null }, preconditions: [],
    ...(withF3 ? { falsifiableWhen: { kind: 'text-pattern', rule: 'missing-module', when: when ?? `当模块 /d/ws/src/app.mjs 可被加载时不再成立`, quote: QUOTE } } : {}),
    occurredAt: T(21), recordedAt: T(21), validFrom: null, validTo: null,
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
  }]);
  return { root, store };
}

const hit = {
  episode: 'ep-aaaaaaa1', nodeId: null, link: null, why: ['module', 'app'], weight: 1,
  occurredAt: T(21), kind: 'failure', seq: 41, depth: 1, claimId: 'c-0000f301',
};
const walkOf = (hits) => ({ hits, path: [], omitted: { count: 0, reason: '' }, tokens: 0, depth: 1 });
const cardLines = (card) => String(card.section ?? '').split('\n').filter((l) => l.startsWith('- '));

test('T345 ① 有 F3 ⇒ 尾注在坐标之后（正文仍是逐字原文）', () => {
  const { root, store } = makeStore(true);
  try {
    const card = buildMemoryCard({ walkResult: walkOf([hit]), store, scope: SCOPE, now: T(24) });
    const line = cardLines(card)[0];
    assert.ok(line.includes('当模块'), line);
    assert.ok(line.includes('[missing-module]'), line);
    assert.ok(line.indexOf('当模块') > line.indexOf('seq 41'), '尾注必须在坐标之后');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T345 ② `f3OnCard:false` ⇒ 无尾注（与 0.6.3 之前逐字节一致，tombstone）', () => {
  const { root, store } = makeStore(false);
  try {
    const card = buildMemoryCard({ walkResult: walkOf([hit]), store, scope: SCOPE, now: T(24), f3OnCard: false });
    const line = cardLines(card)[0];
    assert.ok(!line.includes('当模块'), line);
    assert.ok(/^\- \[[^\]]+\] .+ \(ep-[0-9a-f]{8}, [^,]+, seq 41\)$/.test(line), `旧格式必须原样：${line}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T347 ① 历史 claim（**没有**存 falsifiableWhen）⇒ 读时派生兜底，仍上卡', () => {
  const { root, store } = makeStore(false); // 库里没有该字段（模拟 1305 条历史 claim）
  try {
    const card = buildMemoryCard({ walkResult: walkOf([hit]), store, scope: SCOPE, now: T(24) });
    const [parsed] = parseCardLines(card.section);
    assert.ok(parsed.falsifiableWhen?.includes('当模块'), '历史 claim 也必须能派生 F3');
    assert.equal(parsed.text, QUOTE, '派生不许污染逐字正文');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T347 ② 派生是纯函数：两次建卡逐字节相同（确定性，可复算）', () => {
  const { root, store } = makeStore(false);
  try {
    const a = buildMemoryCard({ walkResult: walkOf([hit]), store, scope: SCOPE, now: T(24) }).section;
    const b = buildMemoryCard({ walkResult: walkOf([hit]), store, scope: SCOPE, now: T(25) }).section;
    assert.equal(a, b, '同库同题 ⇒ 卡片逐字节相同（now 只进 shadow 记录）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T345 ③ 审计解析：text 只取逐字正文，F3 单独给字段（tombstone）', () => {
  const { root, store } = makeStore(true);
  try {
    const card = buildMemoryCard({ walkResult: walkOf([hit]), store, scope: SCOPE, now: T(24) });
    const [parsed] = parseCardLines(card.section);
    assert.equal(parsed.text, QUOTE, 'F3 绝不许混进 text（否则 A6 报 missing）');
    assert.equal(parsed.seq, 41);
    assert.ok(parsed.falsifiableWhen?.includes('当模块'), 'F3 必须能解析出来');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T345 ④ F3 超长 ⇒ 截断到 F3_MAX_CHARS（不撑爆预算）', () => {
  const { root, store } = makeStore(true, { when: '当'.repeat(200) });
  try {
    const card = buildMemoryCard({ walkResult: walkOf([hit]), store, scope: SCOPE, now: T(24) });
    const [parsed] = parseCardLines(card.section);
    const when = String(parsed.falsifiableWhen ?? '').split(' [')[0];
    assert.ok(when.length <= F3_MAX_CHARS, `尾注应 ≤${F3_MAX_CHARS}，实际 ${when.length}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T345 ⑤ 旧格式行（无尾注）仍解析，falsifiableWhen=null（向后兼容）', () => {
  const old = '- [antipattern] Error: boom (ep-aaaaaaa1, 2026-11-06, seq 12)';
  const [parsed] = parseCardLines(old);
  assert.equal(parsed.text, 'Error: boom');
  assert.equal(parsed.seq, 12);
  assert.equal(parsed.falsifiableWhen, null);
});
