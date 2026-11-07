// R16 plugin（宿主入口 · agent/pre-step）的 tombstone test：删掉 src/plugin.mjs ⇒ 本文件整片红。
//
// 覆盖（任务书 T9 的六个场景 + 边界）：
//   1. 没有记忆库 ⇒ 原 decision 原样返回（**引用相等**）
//   2. 有命中 ⇒ 注入一条 user 消息：source.kind = "dsh-kifuin"、文本含 indexLine
//   3. 同一会话第二次 ⇒ 不再注入（WeakSet）
//   4. buildMemoryCard 抛错 ⇒ 原 decision + `ctx.logger.warn` 被记录（失败不阻塞会话）
//   5. gates.ok === false ⇒ 不注入（降级为原 decision）
//   6. shadow:true ⇒ 不注入、写 evidence/shadow、原 decision
//   7. 默认配置（enabled:false, shadow:false）⇒ 什么都不做
//   8. decision.kind !== "enter" ⇒ 原样返回
//   9. **不写会话事件**：session.append 一次都没被调用；原数组不被原地改
//  10. 插入位置 = 最后一条 claimed 消息之后（与压缩插件同一语义，互不代管）
//  11. 宿主包解析不到 ⇒ 用本地等价工厂注入（形状与宿主 createUserMessage 对齐）
//  12. 纯函数：messageText / lastUserText / digestOf / insertAfterClaimed / cardText / sanitizeConfig

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CARD_SOURCE_FORM,
  CARD_SOURCE_KIND,
  DEFAULT_CONFIG,
  HOOK,
  PLUGIN_VERSION,
  apply,
  cardText,
  digestOf,
  insertAfterClaimed,
  lastUserText,
  messageText,
  name,
  sanitizeConfig,
  signalFromMessages,
} from '../src/plugin.mjs';
import { scopeKeyFromPath } from '../src/rooms/inject.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = (day) => Date.UTC(2026, 9, day, 12, 0, 0); // 2026-10-DD

// ---------------------------------------------------------------------------
// 夹具：假 ctx / 假 session / 临时记忆库 / 假 createUserMessage
// ---------------------------------------------------------------------------

function makeCtx() {
  const hooks = {};
  const warns = [];
  const ctx = {
    logger: {
      warn: (line) => warns.push(String(line)),
      info: () => {},
      debug: () => {},
    },
    on: (event, handler) => {
      hooks[event] = handler;
      return () => {
        if (hooks[event] === handler) delete hooks[event];
      };
    },
  };
  return { ctx, hooks, warns };
}

/** 假 session：`append` 一旦被调用就记下来（用来证明"不写会话事件"）。 */
function makeSession(cwd) {
  const appended = [];
  const session = {
    id: 'session-test0001',
    cwd,
    append: (...args) => {
      appended.push(args);
      throw new Error('棋院不写会话事件');
    },
  };
  return { session, appended };
}

/** 假消息构造器（替身；真实宿主里是 @deepseek-ai/dsh-llm 的 createUserMessage）。 */
function fakeCreateUserMessage(input) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    ...input,
    __fake: true,
  };
}

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const enterDecision = (messages) => ({ kind: 'enter', messages, meta: { tagged: true } });

/** 临时工作区 + 与之同域的临时记忆库（含主题/棋谱/claim，保证 walk 能命中）。 */
function makeWorkspace() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'kifuin-ws-'));
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'kifuin-store-'));
  const scope = scopeKeyFromPath(workspace);
  const store = createStore({ root: storeRoot, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [{
    id: 'ep-aaaaaaa1',
    sessionId: 'session-aaaaaaa1',
    scopeKey: scope,
    startedAt: T(21),
    firstEventAt: T(21),
    lastEventAt: T(21),
    recordedAt: T(21),
    closure: { logPath: 'sessions/a/x/session.v4.jsonl.zstd', graphPath: 'graphs/a/graph.json', seqFrom: 11, seqTo: 99 },
    l0: 'demo episode',
    signals: { failures: 3, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    state: 'archived',
  }]);
  store.replaceDerived('topics', [
    { id: 't:term:aaaa0001', kind: 'term', key: 'yaml', df: 2, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(21), episodes: ['ep-aaaaaaa1'] },
  ], { at: T(24) });
  store.putMany('claims', [{
    id: 'c-scope001',
    kind: 'antipattern',
    text: "Cannot find module 'yaml'",
    scopeKey: scope,
    threadIds: [],
    state: 'observed',
    support: [{ episode: 'ep-aaaaaaa1', seq: 30, quote: 'Error: boom' }],
    counter: [],
    validity: { type: 'none', value: null },
    preconditions: [],
    occurredAt: T(21),
    recordedAt: T(21),
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
  }]);
  return { workspace, storeRoot, scope, cleanup: () => { rmSync(workspace, { recursive: true, force: true }); rmSync(storeRoot, { recursive: true, force: true }); } };
}

/** 跑一次 pre-step：返回 hook 的返回值（= 宿主拿到的 decision）。 */
async function runHook({ hooks, payload, decision }) {
  const hook = hooks[HOOK];
  assert.equal(typeof hook, 'function', 'apply() 必须挂上 agent/pre-step');
  return hook(payload, async () => decision);
}

const baseConfig = (over = {}) => ({
  enabled: true,
  shadow: false,
  autoBuild: false, // 测试里不真的建库（autoBuild 会写盘并跑 14s 归档）
  now: T(24),
  limit: 5,
  budgetTokens: 500,
  createUserMessage: fakeCreateUserMessage,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. 没有记忆库 ⇒ 原 decision（引用相等）
// ---------------------------------------------------------------------------

test('R16: 没有记忆库 ⇒ 原 decision 原样返回（引用相等），并且记一条 warn', async () => {
  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(mkdtempSync(path.join(tmpdir(), 'kifuin-nows-')));
  const res = apply(ctx, baseConfig({ storeRoot: path.join(tmpdir(), 'kifuin-missing-store-xyz') }));
  assert.equal(res.registered, true);

  const original = enterDecision([userMessage('yaml 装不上')]);
  const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

  assert.equal(out, original, '必须是同一个对象（引用相等）');
  assert.ok(warns.some((w) => w.includes('记忆库不存在')), `应当记录 warn，实际：${warns.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// 2. 有命中 ⇒ 注入一条
// ---------------------------------------------------------------------------

test('R16: 有命中 ⇒ 注入一条 user 消息（source.kind="dsh-kifuin"、文本含 indexLine）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session, appended } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));

    const claimed = [userMessage('yaml 装不上')];
    const original = enterDecision([...claimed]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: claimed }, decision: original });

    assert.notEqual(out, original, '注入后必须是新 decision');
    assert.equal(out.kind, 'enter');
    assert.equal(out.messages.length, 2, '原 1 条 + 注入 1 条');
    const injected = out.messages[1];
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, CARD_SOURCE_KIND);
    assert.equal(injected.source.form, CARD_SOURCE_FORM);
    assert.equal(injected.source.pluginVersion, PLUGIN_VERSION);
    assert.match(injected.source.digest, /^[0-9a-f]{16}$/);

    const text = messageText(injected);
    assert.ok(text.includes('MEMORY:'), '文本里要有首轮那一行 INDEX 指针');
    assert.ok(text.includes('<memory-ledger>'), '命中就要展开');
    assert.ok(text.includes('ep-aaaaaaa1'), '展开行要带出处');
    assert.ok(text.includes('2026-10-21'), '展开行要带绝对日期');

    // 原数组没被原地改；也没写会话事件
    assert.equal(original.messages.length, 1, '原 decision.messages 不许被原地修改');
    assert.equal(appended.length, 0, '不许调用 session.append');
    assert.equal(out.meta.tagged, true, '其余字段原样透传');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. 每会话只注入一次
// ---------------------------------------------------------------------------

test('R16: 同一会话第二次调用 ⇒ 不再注入（WeakSet 记住这个 session）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));
    const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };

    const first = await runHook({ hooks, payload, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(first.messages.length, 2, '第一次应当注入');

    const secondOriginal = enterDecision([userMessage('yaml 还是装不上')]);
    const second = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 还是装不上')] }, decision: secondOriginal });
    assert.equal(second, secondOriginal, '第二次必须原样返回');

    // 换一个会话（新对象）⇒ 又能注入
    const other = makeSession(workspace).session;
    const third = await runHook({ hooks, payload: { agent: { session: other }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(third.messages.length, 2, '新会话仍然只注入一次');
  } finally {
    cleanup();
  }
});

test('R16: oncePerSession:false ⇒ 每步都能注入（配置可关掉这条限流）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot, oncePerSession: false }));
    const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };
    const a = await runHook({ hooks, payload, decision: enterDecision([userMessage('yaml 装不上')]) });
    const b = await runHook({ hooks, payload, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(a.messages.length, 2);
    assert.equal(b.messages.length, 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. 构建抛错 ⇒ 原 decision + warn
// ---------------------------------------------------------------------------

test('R16: buildMemoryCard 抛错 ⇒ 原 decision + warn 被记录（失败不阻塞会话）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks, warns } = makeCtx();
    const { session, appended } = makeSession(workspace);
    apply(ctx, baseConfig({
      storeRoot,
      deps: {
        buildMemoryCard: () => {
          throw new Error('boom: 构建炸了');
        },
      },
    }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original, '异常时必须原样返回');
    assert.ok(warns.some((w) => w.includes('注入失败') && w.includes('boom')), `warn 内容：${warns.join(' | ')}`);
    assert.equal(appended.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. 闸门不过 ⇒ 不注入
// ---------------------------------------------------------------------------

test('R16: gates.ok === false ⇒ 不注入、原 decision、并记 warn', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks, warns } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({
      storeRoot,
      deps: {
        runGates: () => ({ ok: false, errors: [{ gate: '0', code: 'gate0/missing-seq', detail: null }], checks: {} }),
      },
    }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original, '闸门不过就不注入');
    assert.ok(warns.some((w) => w.includes('闸门未通过') && w.includes('gate0/missing-seq')), warns.join(' | '));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. shadow ⇒ 不注入 + 写记录
// ---------------------------------------------------------------------------

test('R16: shadow:true ⇒ 不注入、写 evidence/shadow、原 decision', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  const shadowDir = mkdtempSync(path.join(tmpdir(), 'kifuin-shadow-'));
  try {
    const { ctx, hooks } = makeCtx();
    const { session, appended } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot, shadow: true, shadowDir }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original, '影子模式必须原样返回');
    const file = path.join(shadowDir, 'shadow.jsonl');
    assert.equal(existsSync(file), true, '影子记录要落盘');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.injected, false, '影子记录必须标 injected:false');
    assert.equal(record.mode, 'shadow');
    assert.ok(record.card.section.includes('<memory-ledger>'));
    assert.equal(appended.length, 0);

    // 同一会话再来一次：不重复写影子（每会话一次）
    await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });
    const again = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(again.length, 1, '同一会话只记一条');
  } finally {
    rmSync(shadowDir, { recursive: true, force: true });
    cleanup();
  }
});

test('R16: shadow 写不进去（目录在 $DSH_HOME 内）⇒ 不注入、不抛、warn', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  const home = path.join(tmpdir(), `fake-dsh-home-${process.pid}`);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, hooks, warns } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot, shadow: true, shadowDir: path.join(home, 'evidence', 'shadow') }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original);
    assert.ok(warns.some((w) => w.includes('影子记录写入失败')), warns.join(' | '));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7/8. 默认关 & 非 enter
// ---------------------------------------------------------------------------

test('R16: 显式关掉（enabled:false）⇒ 什么都不做', async () => {
  assert.equal(DEFAULT_CONFIG.enabled, true, '零配置默认开（2026-11-02 主人裁定）');
  assert.equal(DEFAULT_CONFIG.shadow, false, '零配置默认真注入');
  assert.equal(DEFAULT_CONFIG.autoBuild, true, '零配置默认自动建库');

  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(tmpdir());
  apply(ctx, { enabled: false, shadow: false, createUserMessage: fakeCreateUserMessage });
  const original = enterDecision([userMessage('任意')]);
  const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('任意')] }, decision: original });
  assert.equal(out, original);
  assert.deepEqual(warns, [], '关掉的时候连 warn 都不该有');
});

test('R16: apply 默认参数 ⇒ 注册钩子且默认开启（无库时沉默）', async () => {
  const { ctx, hooks } = makeCtx();
  const res = apply(ctx);
  assert.equal(res.registered, true);
  assert.equal(res.config.enabled, true);
  assert.equal(typeof hooks[HOOK], 'function');
});

test('T362: apply 返回严格同 Promise 的 disposer，并同步清理两个事件钩子', async () => {
  const { ctx, hooks } = makeCtx();
  const effect = apply(ctx, { enabled: false, shadow: false, autoBuild: false });
  assert.equal(typeof effect, 'function', 'Cordis 4.1 effect 必须是函数，不能是诊断对象');
  assert.equal(effect.registered, true, '旧诊断字段作为 disposer 属性保留');
  assert.equal(effect.config.enabled, false);
  assert.equal(typeof hooks[HOOK], 'function');
  assert.equal(typeof hooks['agent/turn-stopping'], 'function');
  const first = effect();
  assert.equal(typeof first?.then, 'function', '没有 build 时也必须返回 Promise');
  assert.equal(hooks[HOOK], undefined, '事件 off 必须在首次调用内同步完成');
  assert.equal(hooks['agent/turn-stopping'], undefined);
  const second = effect();
  assert.strictEqual(second, first, '并发重复 dispose 必须严格复用同一 Promise');
  await first;
  assert.strictEqual(effect(), first, '清理完成后仍必须返回同一 Promise');
});

test('T367: dispose 取消 queued timer、释放同 root，stale hook 不再调度', async () => {
  const { ctx, hooks } = makeCtx();
  const { session } = makeSession(tmpdir());
  let calls = 0;
  const storeRoot = path.join(tmpdir(), `kifuin-autobuild-cancel-${process.pid}-${Date.now()}`);
  const config = () => baseConfig({
    storeRoot,
    autoBuild: true,
    deps: { buildStore: async () => { calls += 1; } },
  });
  const effect = apply(ctx, config());
  const original = enterDecision([userMessage('yaml 装不上')]);
  const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };
  await runHook({ hooks, payload, decision: original });
  const staleHook = hooks[HOOK];
  const disposing = effect();
  assert.strictEqual(effect(), disposing);
  await disposing;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 0, '计时器取消后不得再开始建库');
  assert.deepEqual(hooks, {}, '两个监听器也必须清理');

  await staleHook(payload, async () => original);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 0, '已捕获的 stale pre-step 也不得在 dispose 后重新调度');
  assert.strictEqual(effect(), disposing, 'stale hook 之后重复 dispose 仍严格同 Promise');

  const next = makeCtx();
  const nextEffect = apply(next.ctx, config());
  await runHook({ hooks: next.hooks, payload, decision: original });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, '取消必须释放全局锁，同 root 后续挂载可以重新建库');
  await nextEffect();
  assert.deepEqual(next.hooks, {});
});

test('T368: dispose-during-build 与并发重复调用均等待同一清理', async () => {
  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(tmpdir());
  let calls = 0;
  let finished = 0;
  let markStarted;
  let releaseBuild;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseBuild = resolve; });
  const storeRoot = path.join(tmpdir(), `kifuin-autobuild-dispose-${process.pid}-${Date.now()}`);
  const effect = apply(ctx, baseConfig({
    storeRoot,
    autoBuild: true,
    deps: {
      buildStore: async () => {
        calls += 1;
        markStarted();
        await gate;
        finished += 1;
      },
    },
  }));
  const original = enterDecision([userMessage('yaml 装不上')]);
  await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });
  await started;
  let settled = 0;
  const first = effect();
  const second = effect();
  const disposing = Promise.resolve(first).then(() => { settled += 1; });
  const repeated = Promise.resolve(second).then(() => { settled += 1; });
  try {
    assert.equal(second, first, '并发重复 dispose 必须复用首次清理 Promise');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, 0, 'build 未结束时两次 dispose 都不得提前完成');
    assert.equal(finished, 0, 'gate 未释放时 build 本身也不得完成');
  } finally {
    releaseBuild();
    await Promise.all([disposing, repeated]);
  }
  assert.equal(calls, 1);
  assert.equal(finished, 1, 'dispose 等待的是真实 build 完成');
  assert.deepEqual(hooks, {});
  assert.equal(warns.some((line) => line.includes('记忆库已刷新')), false, 'dispose 后不得迟写成功日志');
  assert.equal(effect(), first, '清理完成后重复调用仍返回同一 Promise');
});

test('T369: 双 apply 同 root 共享 queued build，旧 owner dispose 不取消新 owner', { timeout: 3000 }, async () => {
  const a = makeCtx();
  const b = makeCtx();
  const { session } = makeSession(tmpdir());
  let calls = 0;
  let laterCalls = 0;
  let finished = 0;
  let markStarted;
  let releaseBuild;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseBuild = resolve; });
  const storeRoot = path.join(tmpdir(), `kifuin-autobuild-shared-queued-${process.pid}-${Date.now()}`);
  const effectA = apply(a.ctx, baseConfig({
    storeRoot,
    autoBuild: true,
    deps: {
      buildStore: async () => {
        calls += 1;
        markStarted();
        await gate;
        finished += 1;
      },
    },
  }));
  const effectB = apply(b.ctx, baseConfig({
    storeRoot,
    autoBuild: true,
    deps: { buildStore: async () => { laterCalls += 1; } },
  }));
  const original = enterDecision([userMessage('yaml 装不上')]);
  const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };
  try {
    await runHook({ hooks: a.hooks, payload, decision: original });
    await runHook({ hooks: b.hooks, payload, decision: original });

    const disposingA = effectA();
    assert.strictEqual(effectA(), disposingA);
    await disposingA;
    await started;
    assert.equal(calls, 1, 'A 退出后 B 仍必须启动共享 queued build');
    assert.equal(laterCalls, 0, '后到 apply 共享先到 record/task，不另起 build');

    const disposingB = effectB();
    assert.equal(typeof disposingB?.then, 'function');
    let settledB = false;
    const observedB = disposingB.then(() => { settledB = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settledB, false, 'running build 未完成时 B dispose 必须等待共享 task');
    assert.equal(finished, 0);
    releaseBuild();
    await Promise.all([disposingB, observedB]);
  } finally {
    releaseBuild();
    await Promise.all([effectA(), effectB()]);
  }
  assert.equal(calls, 1);
  assert.equal(laterCalls, 0);
  assert.equal(finished, 1);
  assert.deepEqual(a.hooks, {});
  assert.deepEqual(b.hooks, {});
});

test('T370: 双 apply 同 root running 时 owner 先后 dispose 都等待共享 task', { timeout: 3000 }, async () => {
  const a = makeCtx();
  const b = makeCtx();
  const { session } = makeSession(tmpdir());
  let calls = 0;
  let finished = 0;
  let markStarted;
  let releaseBuild;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseBuild = resolve; });
  const storeRoot = path.join(tmpdir(), `kifuin-autobuild-shared-running-${process.pid}-${Date.now()}`);
  const buildStore = async () => {
    calls += 1;
    markStarted();
    await gate;
    finished += 1;
  };
  const effectA = apply(a.ctx, baseConfig({ storeRoot, autoBuild: true, deps: { buildStore } }));
  const effectB = apply(b.ctx, baseConfig({ storeRoot, autoBuild: true, deps: { buildStore } }));
  const original = enterDecision([userMessage('yaml 装不上')]);
  const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };
  try {
    await runHook({ hooks: a.hooks, payload, decision: original });
    await runHook({ hooks: b.hooks, payload, decision: original });
    await started;
    assert.equal(calls, 1);

    const disposingA = effectA();
    let settledA = false;
    const observedA = disposingA.then(() => { settledA = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settledA, false, '第一个 running owner dispose 必须等待');
    assert.equal(finished, 0);

    const disposingB = effectB();
    assert.equal(typeof disposingB?.then, 'function', '第二个 owner 必须持有同一共享 task');
    let settledB = false;
    const observedB = disposingB.then(() => { settledB = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settledA, false);
    assert.equal(settledB, false, '后 dispose 的 running owner 也必须等待');
    assert.equal(finished, 0);

    releaseBuild();
    await Promise.all([disposingA, disposingB, observedA, observedB]);
  } finally {
    releaseBuild();
    await Promise.all([effectA(), effectB()]);
  }
  assert.equal(calls, 1, '两个 running owner 只能共享一次真实 build');
  assert.equal(finished, 1);
  assert.deepEqual(a.hooks, {});
  assert.deepEqual(b.hooks, {});
});

test('R16: decision.kind !== "enter" ⇒ 原样返回（不碰 messages）', async () => {
  const { ctx, hooks } = makeCtx();
  const { session } = makeSession(tmpdir());
  apply(ctx, baseConfig({ storeRoot: path.join(tmpdir(), 'nope-store-123') }));
  const decision = { kind: 'skip', messages: [userMessage('x')] };
  const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('x')] }, decision });
  assert.equal(out, decision);
});

test('R16: 没有 user 文本 ⇒ 不注入（signal 缺失就沉默）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));
    const original = enterDecision([]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [] }, decision: original });
    assert.equal(out, original);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9/10. 不写会话事件 + 插入位置
// ---------------------------------------------------------------------------

test('R16: 注入位置 = 最后一条 claimed 消息之后（后面的非 claimed 消息保持在尾部）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));

    const a = userMessage('第一条');
    const b = userMessage('yaml 装不上');
    const tail = { role: 'user', content: [{ type: 'text', text: '非 claimed：后加的' }] };
    const claimed = [a, b];
    const original = enterDecision([a, b, tail]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: claimed }, decision: original });

    assert.equal(out.messages.length, 4);
    assert.equal(out.messages[0], a);
    assert.equal(out.messages[1], b);
    assert.equal(out.messages[2].source.kind, CARD_SOURCE_KIND, '插在最后一条 claimed（b）之后');
    assert.equal(out.messages[3], tail, '非 claimed 的消息仍在其后');
    // 原数组未变
    assert.deepEqual(original.messages.map((m) => m === tail), [false, false, true]);
  } finally {
    cleanup();
  }
});

test('R16: 宿主包解析不到时用本地等价工厂注入（2026-11-04 起不再依赖 asar 内包）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, { enabled: true, shadow: false, storeRoot, now: T(24) }); // 故意不给 createUserMessage
    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });
    assert.notEqual(out, original, '有命中就该注入（本地工厂兜底）');
    const injected = out.messages.find((m) => m?.source?.kind === 'dsh-gokifu-longmemory');
    assert.ok(injected, '注入消息必须带 source.kind');
    assert.equal(injected.role, 'user');
    assert.ok(Object.isFrozen(injected));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 12. 纯函数
// ---------------------------------------------------------------------------

test('R16: messageText / lastUserText 兼容三种消息形态', () => {
  assert.equal(messageText({ role: 'user', content: 'hi' }), 'hi');
  assert.equal(messageText({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(messageText({ role: 'user', content: { text: 'obj' } }), 'obj');
  assert.equal(messageText({ text: 'bare' }), 'bare');
  assert.equal(messageText(null), '');
  assert.equal(messageText({ role: 'user', content: [] }), '');

  assert.equal(lastUserText([userMessage('一'), { role: 'assistant', content: '二' }, userMessage('三')]), '三');
  assert.equal(lastUserText([{ role: 'assistant', content: '只有助手' }]), '');
  assert.equal(lastUserText([]), '');
  assert.equal(lastUserText(null), '');
});

test('R16: digestOf 同输入同输出、不同 scope/文本不同', () => {
  const a = digestOf('w:d:/x', 'MEMORY: a');
  const b = digestOf('w:d:/x', 'MEMORY: a');
  const c = digestOf('w:d:/y', 'MEMORY: a');
  const d = digestOf('w:d:/x', 'MEMORY: b');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('R16: insertAfterClaimed 用引用判 claimed，且不改原数组', () => {
  const a = userMessage('a');
  const b = userMessage('b');
  const extra = userMessage('extra');
  const message = { role: 'user', injected: true };
  const messages = [a, b, extra];
  const out = insertAfterClaimed(messages, [a, b], message);
  assert.equal(out.length, 4);
  assert.equal(out[2], message);
  assert.equal(messages.length, 3, '原数组不变');

  // 只有 a 是 claimed ⇒ 插在 a 之后
  const out2 = insertAfterClaimed(messages, [a], message);
  assert.equal(out2[1], message);

  // 找不到 claimed ⇒ 插到开头之后（与上游 Math.max(lastClaimed,0)+1 一致）
  const out3 = insertAfterClaimed(messages, [], message);
  assert.equal(out3[1], message);

  assert.equal(insertAfterClaimed(null, [], message), null);
});

test('R16: cardText = indexLine + section；两条都缺就空串', () => {
  assert.equal(cardText({ indexLine: 'MEMORY: x', section: '<memory-ledger>y</memory-ledger>' }), 'MEMORY: x\n<memory-ledger>y</memory-ledger>');
  assert.equal(cardText({ indexLine: 'MEMORY: x', section: null }), 'MEMORY: x');
  assert.equal(cardText(null), '');
});

test('R16: sanitizeConfig 只认已知键、类型不对退回默认', () => {
  assert.deepEqual(sanitizeConfig(), { ...DEFAULT_CONFIG });
  const c = sanitizeConfig({ enabled: 'true', shadow: 'false', budgetTokens: 200, limit: '3', storeRoot: ' D:/x/ ', deps: { a: 1 }, createUserMessage: () => 'x' });
  assert.equal(c.enabled, true);
  assert.equal(c.shadow, false);
  assert.equal(c.budgetTokens, 200);
  assert.equal(c.limit, 3);
  assert.equal(c.storeRoot, 'D:/x/');
  assert.equal(typeof c.deps, 'object');
  assert.equal(typeof c.createUserMessage, 'function');
  // 垃圾值
  const bad = sanitizeConfig({ enabled: 123, budgetTokens: -5, limit: 'abc', storeRoot: 42, deps: 'nope', createUserMessage: 'nope' });
  assert.equal(bad.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(bad.budgetTokens, DEFAULT_CONFIG.budgetTokens);
  assert.equal(bad.limit, DEFAULT_CONFIG.limit);
  assert.equal(bad.storeRoot, null);
  assert.equal(bad.deps, null);
  assert.equal(bad.createUserMessage, null);
});

test('R16: 插件名与常量（宿主靠它认人）', () => {
  assert.equal(name, 'dsh-gokifu-longmemory');
  assert.equal(HOOK, 'agent/pre-step');
  assert.equal(CARD_SOURCE_KIND, 'dsh-gokifu-longmemory');
  assert.equal(CARD_SOURCE_FORM, 'memory-card');
  assert.equal(PLUGIN_VERSION, 1);
});

// ---------------------------------------------------------------------------
// T12：闸 3 真核验接进注入路径（validity 核不过 ⇒ 不注入）
// ---------------------------------------------------------------------------

test('R16: 闸 3 真核验 —— validity 核不过 ⇒ 闸不过 ⇒ 不注入（probeValidity:false 才退回 unverified）', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'kifuin-ws-bad-'));
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'kifuin-store-bad-'));
  try {
    const scope = scopeKeyFromPath(workspace);
    const store = createStore({ root: storeRoot, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [{
      id: 'ep-badaaaa1', sessionId: 'session-badaaaa1', scopeKey: scope,
      startedAt: T(21), firstEventAt: T(21), lastEventAt: T(21), recordedAt: T(21),
      closure: { logPath: 'sessions/a/x/session.v4.jsonl.zstd', graphPath: 'graphs/a/graph.json', seqFrom: 11, seqTo: 99 },
      l0: 'demo', signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] }, state: 'archived',
    }]);
    store.replaceDerived('topics', [{ id: 't:term:bad00001', kind: 'term', key: 'yaml', df: 2, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(21), episodes: ['ep-badaaaa1'] }], { at: T(24) });
    store.putMany('claims', [{
      id: 'c-bad00001', kind: 'antipattern', text: "Cannot find module 'yaml'", scopeKey: scope, threadIds: [],
      state: 'observed', support: [{ episode: 'ep-badaaaa1', seq: 30, quote: 'Error: boom' }], counter: [],
      validity: { type: 'file', value: 'definitely-missing.yaml' }, preconditions: [],
      occurredAt: T(21), recordedAt: T(21), counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
    }]);

    // 默认 probeValidity=true ⇒ 真核验 ⇒ 核不过 ⇒ 闸 3 打回 ⇒ 不注入
    const a = makeCtx();
    apply(a.ctx, baseConfig({ storeRoot }));
    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks: a.hooks, payload: { agent: { session: makeSession(workspace).session }, messages: [userMessage('yaml 装不上')] }, decision: original });
    assert.equal(out, original, 'validity 核不过就不许注入');
    assert.ok(a.warns.some((w) => w.includes('gate3/')), a.warns.join(' | '));

    // probeValidity:false ⇒ 不核 ⇒ 闸 3 记 unverified ⇒ 照常注入（不假绿，但也不假红）
    const b = makeCtx();
    apply(b.ctx, baseConfig({ storeRoot, probeValidity: false }));
    const out2 = await runHook({ hooks: b.hooks, payload: { agent: { session: makeSession(workspace).session }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(out2.messages.length, 2, '不核验时行为与 T9 一致');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('R16: storeRoot 支持 <DSH_HOME> / $DSH_HOME 占位符；无 home 时视为未配置', async () => {
  const { enforceStoreRoot } = await import('../src/plugin.mjs');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(tmpdir(), 'kifuin-home-placeholder');
  try {
    assert.equal(enforceStoreRoot('<DSH_HOME>/memory-context'), path.resolve(process.env.DSH_HOME, 'memory-context'));
    assert.equal(enforceStoreRoot('$DSH_HOME/memory-context'), path.resolve(process.env.DSH_HOME, 'memory-context'));
  } finally {
    delete process.env.DSH_HOME;
    assert.equal(enforceStoreRoot('<DSH_HOME>/memory-context'), null, '无 home 时占位符不可解析 ⇒ null（沉默，不猜路径）');
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  }
});

test('R16: 零配置自动建库 —— 本次沉默，成功 record 保留去重', async () => {
  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(tmpdir());
  let calls = 0;
  const storeRoot = path.join(tmpdir(), `kifuin-autobuild-${process.pid}-${Date.now()}`);
  const effect = apply(ctx, baseConfig({
    storeRoot,
    autoBuild: true,
    deps: { buildStore: async () => { calls += 1; } },
  }));
  const original = enterDecision([userMessage('yaml 装不上')]);
  const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };
  const out = await runHook({ hooks, payload, decision: original });
  assert.equal(out, original, '建库期间必须沉默');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, '后台应当只建一次');
  assert.ok(warns.some((w) => w.includes('记忆库不存在')), warns.join(' | '));

  await runHook({ hooks, payload, decision: original });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, '成功 record 必须保留，同 root 再次 pre-step 不重复建库');
  await effect();
});

test('T371: autoBuild reject 后删除当前 record，重试成功后去重', async () => {
  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(tmpdir());
  let calls = 0;
  const storeRoot = path.join(tmpdir(), `kifuin-autobuild-retry-${process.pid}-${Date.now()}`);
  const effect = apply(ctx, baseConfig({
    storeRoot,
    autoBuild: true,
    deps: {
      buildStore: async () => {
        calls += 1;
        if (calls === 1) throw new Error('intentional build reject');
      },
    },
  }));
  const original = enterDecision([userMessage('yaml 装不上')]);
  const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };
  await runHook({ hooks, payload, decision: original });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1);
  assert.equal(warns.filter((line) => line.includes('自动建库失败') && line.includes('intentional build reject')).length, 1);

  await runHook({ hooks, payload, decision: original });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 2, '失败必须释放当前 record，下一次 pre-step 可以重试');

  await runHook({ hooks, payload, decision: original });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 2, '重试成功后保留 record，第三次不再建库');
  await effect();
});

test('R16: 设置页 schema —— 暴露 storeRoot（记忆库地址）等字段，validate 归一化', async () => {
  const { Config } = await import('../src/plugin.mjs');
  const schema = Config.toJSON();
  assert.equal(schema.type, 'object');
  assert.ok(schema.dict.storeRoot, '必须暴露 storeRoot，GUI 才能选地址');
  assert.match(schema.dict.storeRoot.meta.description, /memory-context/);
  assert.equal(Config['~standard'].validate({ storeRoot: ' D:/mem ' }).value.storeRoot, 'D:/mem');
  assert.equal(Config['~standard'].validate({}).value.enabled, true);
  assert.equal(Config['~standard'].validate(null).value.shadow, false);
});

// D1（2026-11-02）：轮次收尾时按时间阈值增量刷新
test('D1: turn-stopping 在库过期时触发一次刷新，未过期不触发', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-d1-'));
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ updatedAt: Date.now() - 2 * 3600 * 1000 }));

  const { ctx, hooks } = makeCtx();
  let calls = 0;
  const res = apply(ctx, baseConfig({
    storeRoot: root,
    autoArchive: true,
    autoArchiveMinutes: 30,
    deps: { buildStore: async () => { calls += 1; } },
  }));
  assert.equal(res.registered, true);
  assert.equal(typeof hooks['agent/turn-stopping'], 'function', '必须挂上 turn-stopping');

  await hooks['agent/turn-stopping']({});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, '过期库应当刷新一次');

  // 未过期（刚写过未来时间）⇒ 不再触发
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ updatedAt: Date.now() + 3600 * 1000 }));
  await hooks['agent/turn-stopping']({});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, '未过期不应刷新');
  await res();
});

// D5（2026-11-02，主人批准）：同会话同类失败 ≥N 次 ⇒ 补一次事实卡
test('D5: 同类失败第二次出现才触发，且每会话只补一次', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-d5-'));
  const { ctx, hooks } = makeCtx();
  let injectedCount = 0;
  const res = apply(ctx, baseConfig({
    storeRoot: root,
    repeatHint: true,
    repeatHintAfter: 2,
    repeatHintMax: 1,
    abstainIrrelevant: false, // D5 测的是'重复触发'，与相关性判据无关；占位文本'boom'会被 abstain 拒掉（正确行为，但与本测试无关）
    createUserMessage: (m) => ({ role: 'user', content: [{ type: 'text', text: `CARD:${m.content[0].text}` }] }),
    deps: {
      createStore: () => ({ list: () => [], get: () => null }),
      walk: () => ({ hits: [{ episode: 'ep-x', seq: 1, occurredAt: 1, kind: 'failure', text: 'boom', why: ['x'] }], dropped: {} }),
      buildMemoryCard: () => ({ section: '- [antipattern] boom  (ep-x, 2026-11-02, seq 1)', tokens: 12 }),
      runGates: () => ({ ok: true, errors: [] }),
      createWalkCache: () => ({}),
    },
  }));
  assert.equal(res.registered, true);

  const session = { id: 's-d5' };
  const step = (texts) => hooks['agent/pre-step'](
    { agent: { session }, messages: texts.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) },
    async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }),
  );

  const first = await step(['hello', 'Error: file has not been read — read the file, then retry']);
  assert.equal(first.kind, 'enter');
  // 第一次是「首轮正常注入」；D5 不在这一步动手
  assert.equal(first.messages.length, 2, '第一次同类失败只走正常首轮注入');

  const second = await step(['hello', 'Error: file has not been read — read the file, then retry', 'step', 'Error: file changed since it was read — re-read the file, then retry']);
  assert.ok(second.messages.some((m) => String(m.content?.[0]?.text ?? '').startsWith('CARD:')), '第二次同类失败应补一张卡（oncePerSession 已被首轮占用）');
  injectedCount += 1;

  const third = await step(['a', 'b', 'c', 'd', 'Error: unknown tool "bash"', 'e', 'f', 'Error: unknown tool "bash"', 'g']);
  assert.equal(third.messages.some((m) => String(m.content?.[0]?.text ?? '').startsWith('CARD:')), false, '每会话最多补一次');
  assert.equal(injectedCount, 1);
});

// D5（2026-11-02 补）：闸不过时 D5 也不许强塞——它必须和首轮走同一套十道闸
test('D5: 闸不通过 ⇒ 不补卡（不绕过十道闸）', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-d5-gate-'));
  const { ctx, hooks } = makeCtx();
  const res = apply(ctx, baseConfig({
    storeRoot: root,
    repeatHint: true,
    repeatHintAfter: 2,
    repeatHintMax: 1,
    createUserMessage: (m) => ({ role: 'user', content: [{ type: 'text', text: `CARD:${m.content[0].text}` }] }),
    deps: {
      createStore: () => ({ list: () => [], get: () => null }),
      walk: () => ({ hits: [{ episode: 'ep-x', seq: 1, occurredAt: 1, kind: 'failure', text: 'boom', why: ['x'] }], dropped: {} }),
      buildMemoryCard: () => ({ section: '- [antipattern] boom', tokens: 12 }),
      runGates: () => ({ ok: false, errors: ['imperative'] }),
      createWalkCache: () => ({}),
    },
  }));
  assert.equal(res.registered, true);
  const session = { id: 's-d5-gate' };
  const step = (texts) => hooks['agent/pre-step'](
    { agent: { session }, messages: texts.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) },
    async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }),
  );
  await step(['hello', 'Error: file has not been read — read the file, then retry']);
  const second = await step(['hello', 'Error: file has not been read — read the file, then retry', 'step', 'Error: file changed since it was read — re-read the file, then retry']);
  assert.equal(second.messages.some((m) => String(m.content?.[0]?.text ?? '').startsWith('CARD:')), false, '闸不过不得补卡');
});

// A3 心跳（2026-11-03）：default 开 ⇒ 每步一行 live-stats.jsonl；liveStats:false ⇒ 不写
test('A3 心跳: liveStats 默认写 live-stats.jsonl，关掉则不写', async () => {
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const mk = async (liveStats) => {
    const root = mkdtempSync(path.join(tmpdir(), 'kifu-live-'));
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({
      storeRoot: root,
      ...(liveStats === undefined ? {} : { liveStats }),
      deps: {
        createStore: () => ({ list: () => [], get: () => null }),
        walk: () => ({ hits: [], dropped: {} }),
        buildMemoryCard: () => ({ section: null, tokens: 0, claims: [] }),
        runGates: () => ({ ok: true, errors: [] }),
        createWalkCache: () => ({}),
      },
    }));
    await hooks['agent/pre-step'](
      { agent: { session: { id: `s-${Math.random()}` } }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
      async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }),
    );
    const file = path.join(root, 'live-stats.jsonl');
    return { exists: existsSync(file), text: existsSync(file) ? readFileSync(file, 'utf8') : '' };
  };
  const on = await mk(undefined);
  assert.equal(on.exists, true, '默认应写心跳');
  assert.ok(on.text.split('\n').filter(Boolean).length >= 1);
  const off = await mk(false);
  assert.equal(off.exists, false, 'liveStats:false 不应写');
});

test('R16: 宿主包不可解析时，本地消息工厂形状与宿主一致（不动 asar）', async () => {
  const { makeUserMessageFallback } = await import('../src/plugin.mjs');
  const msg = makeUserMessageFallback({ content: [{ type: 'text', text: 'x' }], source: { kind: 'dsh-gokifu-longmemory', form: 'memory-card', digest: 'abc' } });
  assert.equal(msg.role, 'user');
  assert.match(msg.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(msg.content, [{ type: 'text', text: 'x' }]);
  assert.equal(msg.source.form, 'memory-card');
  assert.ok(Object.isFrozen(msg) && Object.isFrozen(msg.content));
});

test('M4: 注入抽样只写 sidecar，且 8MB 上限后停止', async () => {
  const { appendCardSample } = await import('../src/plugin.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'kifu-sample-'));
  appendCardSample(dir, { digest: 'd1', tokens: 12, section: '<memory-ledger>x</memory-ledger>' });
  // 2026-11-04：留样必须带 pid，审计才能按宿主进程切新旧代码的账
  const firstRow = JSON.parse(readFileSync(path.join(dir, 'card-samples.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(firstRow.pid, process.pid, '留样要带 pid');
  const file = path.join(dir, 'card-samples.jsonl');
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].digest, 'd1');
  assert.match(rows[0].section, /memory-ledger/);
  // 库不存在时不写（不把"无库"变成"有库"）
  const missing = path.join(tmpdir(), 'kifu-missing-' + Date.now());
  appendCardSample(missing, { digest: 'd2' });
  assert.equal(existsSync(path.join(missing, 'card-samples.jsonl')), false);
  rmSync(dir, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// gates-failed 的诊断（0.132.0）：心跳必须能说出"被哪几道闸拦的"
// 线上真事故：两次 gates-failed 的心跳都是 gateIds: null —— 因为只读了不存在的 gates.failed。
// ---------------------------------------------------------------------------

test('R13: gateIdsFromGates 只认 errors 时也能说出闸 id（线上 null 的根因）', async () => {
  const { gateIdsFromGates } = await import('../src/plugin.mjs');
  const ids = gateIdsFromGates({ ok: false, errors: [{ gate: '3', code: 'claim/validity' }, { gate: '2', code: 'claim/scope' }, { gate: '3', code: 'claim/validity' }] });
  assert.deepEqual(ids, ['3', '2'], '去重保序；不许因为缺 gates.failed 就返回空');
});

test('R13: gateIdsFromGates 优先用 gates.failed，没有就从 errors 兜底', async () => {
  const { gateIdsFromGates } = await import('../src/plugin.mjs');
  assert.deepEqual(gateIdsFromGates({ failed: [{ id: '5' }, '6'], errors: [{ gate: '9' }] }), ['5', '6']);
  assert.deepEqual(gateIdsFromGates({}), []);
  assert.deepEqual(gateIdsFromGates(null), []);
});

test('R13: gateCodesFromGates 去重、截断、只给码不给卡内容', async () => {
  const { gateCodesFromGates } = await import('../src/plugin.mjs');
  assert.deepEqual(gateCodesFromGates({ errors: [{ code: 'a' }, { code: 'a' }, { code: 'b' }] }), ['a', 'b']);
  assert.deepEqual(gateCodesFromGates({ errors: Array.from({ length: 9 }, (_, i) => ({ code: `c${i}` })) }), ['c0', 'c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(gateCodesFromGates({}), []);
});

// ---------------------------------------------------------------------------
// T160：gates-failed 的心跳要能说出"被哪几条 claim 拦住"
//
// 现状（precision-auditor 实测）：被闸挡下的卡不入 card-samples.jsonl，心跳行只有
// digest / tokens / gateIds / gateCodes；事件过去后无法还原是哪几条 claim 被拦。
// 补：gateClaimIds（去重、最多 5 个）+ gateLineCount（卡片渲染行数）。
// 边界：**只记 id 与计数，绝不记卡正文**。
// ---------------------------------------------------------------------------

/** 读 live-stats.jsonl 的最后一行（没有文件返回 null）。 */
function lastLiveStatsRow(storeRoot) {
  const file = path.join(storeRoot, 'live-stats.jsonl');
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

test('T160 心跳: gates-failed ⇒ 记 gateClaimIds（去重）与 gateLineCount，且不含卡正文', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  const { buildMemoryCard: realBuildCard } = await import('../src/rooms/inject.mjs');
  let captured = null;
  try {
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({
      storeRoot,
      deps: {
        buildMemoryCard: (args) => { captured = realBuildCard(args); return captured; },
        runGates: () => ({
          ok: false,
          errors: [{ gate: '4', code: 'gate4/unsuperseded-duplicate', detail: { ids: ['c-a', 'c-a', 'c-b'] } }],
          checks: {},
        }),
      },
    }));
    const { session } = makeSession(workspace);
    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });
    assert.equal(out, original, '被闸拦下就不注入');

    const row = lastLiveStatsRow(storeRoot);
    assert.ok(row, '心跳应当写一行');
    assert.equal(row.reason, 'gates-failed');
    assert.deepEqual(row.gateClaimIds, ['c-a', 'c-b'], `gateClaimIds 应是去重后的 id 列表，实际：${JSON.stringify(row.gateClaimIds)}`);
    assert.ok(captured && captured.claims.length >= 1, '夹具应当渲染出至少 1 行');
    assert.equal(row.gateLineCount, captured.claims.length, 'gateLineCount = 卡片渲染行数（card.claims.length）');
    assert.equal(typeof row.gateLineCount, 'number');
    // 边界：心跳里不许出现记忆内容
    assert.equal(JSON.stringify(row).includes('Cannot find module'), false, '心跳里不许出现卡正文');
    assert.equal(JSON.stringify(row).includes('memory-ledger'), false, '心跳里不许出现卡片结构');
  } finally {
    cleanup();
  }
});

test('T160 心跳: errors 里拿不到 id ⇒ gateClaimIds 写 []（不猜、不编）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({
      storeRoot,
      deps: {
        runGates: () => ({
          ok: false,
          errors: [
            { gate: 'anthropic', code: 'boundary/imperative', detail: null }, // 没有 id 字段
            { gate: '6', code: 'gate6/token-mismatch', detail: { expected: 1, actual: 2 } }, // 只有数字
          ],
          checks: {},
        }),
      },
    }));
    const { session } = makeSession(workspace);
    await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });

    const row = lastLiveStatsRow(storeRoot);
    assert.deepEqual(row.gateClaimIds, [], `拿不到 id 就写空数组，实际：${JSON.stringify(row.gateClaimIds)}`);
    assert.ok(Number.isFinite(row.gateLineCount) && row.gateLineCount >= 1, `行数应当是真数，实际：${JSON.stringify(row.gateLineCount)}`);
    assert.deepEqual(row.gateCodes, ['boundary/imperative', 'gate6/token-mismatch'], '错误码照旧');
  } finally {
    cleanup();
  }
});

test('T160 心跳: 非 gates-failed 的行不带这两个字段（不误导）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({ storeRoot }));
    const { session } = makeSession(workspace);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(out.messages.length, 2, '正常注入');
    const row = lastLiveStatsRow(storeRoot);
    assert.equal(row.action, 'inject');
    assert.equal('gateClaimIds' in row, false, '只有 gates-failed 才记这两个字段');
    assert.equal('gateLineCount' in row, false);
  } finally {
    cleanup();
  }
});

test('T160: gateClaimIdsFromGates 去重、限 5 个、只收字符串', async () => {
  const { gateClaimIdsFromGates } = await import('../src/plugin.mjs');
  assert.deepEqual(
    gateClaimIdsFromGates({ errors: [{ detail: { ids: ['c-1', 'c-1', 'c-2'] } }, { detail: { claimId: 'c-3' } }, { detail: { id: 'c-4' } }] }),
    ['c-1', 'c-2', 'c-3', 'c-4'],
  );
  assert.deepEqual(
    gateClaimIdsFromGates({ errors: [{ detail: { ids: ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6'] } }] }),
    ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'],
    '最多 5 个',
  );
  assert.deepEqual(gateClaimIdsFromGates({ errors: [{ detail: { ids: ['c-1', null, 42, ''] } }] }), ['c-1']);
  assert.deepEqual(gateClaimIdsFromGates({ errors: [] }), []);
  assert.deepEqual(gateClaimIdsFromGates(null), []);
});

// ---------------------------------------------------------------- T267（合法信号：最近 N 条消息的硬实体）
//
// 合法性：这些实体在 pre-step 这一刻就在 payload.messages 里（availableAtSeq <= injectionSeq），
// 不是整局棋谱主题那种事后统计（T264 已证明那是作弊）。

test('T267 ①: 最近消息里的文件路径/错误码被抽中（含 assistant 与 tool 角色）', () => {
  const messages = [
    { role: 'user', content: '跑一下测试' },
    { role: 'assistant', content: [{ type: 'text', text: '我看 src/rooms/inject.mjs' }] },
    { role: 'tool', content: 'Error: ENOENT no such file or directory' },
    { role: 'user', content: '修掉它' },
  ];
  const out = signalFromMessages(messages);
  assert.equal(out.text, '修掉它', '最后一条 user 消息必须原样保留（golden）');
  assert.ok(out.entities.includes('enoent'), JSON.stringify(out.entities));
  assert.ok(out.entities.some((e) => e.includes('src/rooms')), JSON.stringify(out.entities));
});

test('T267 ②: 只有最后一条 user 消息时，text 与现状完全一致（golden）', () => {
  const messages = [{ role: 'user', content: '单条消息' }];
  assert.equal(signalFromMessages(messages).text, lastUserText(messages));
  assert.equal(signalFromMessages([]).text, '');
  // 没有实体的普通消息 ⇒ 实体为空（不制造噪声）
  assert.deepEqual(signalFromMessages([{ role: 'user', content: '你好' }]).entities, []);
});

test('T267 ③: 只取最近 N 条（注入点之后的消息不算进来）', () => {
  const messages = [
    { role: 'user', content: '很久以前提过 D:/old/legacy.mjs 与 ENOENT' },
    { role: 'user', content: '中间' },
    { role: 'user', content: '现在只说你好' },
  ];
  const recent = signalFromMessages(messages, { lastN: 1 });
  assert.equal(recent.entities.length, 0, 'lastN=1 时看不到最早那条消息里的实体');
  const all = signalFromMessages(messages, { lastN: 3 });
  assert.ok(all.entities.some((e) => e.includes('legacy')), JSON.stringify(all.entities));
});

// ---------------------------------------------------------------- T268（真实消息语料采集）
import { messageCorpusRow, redactForCorpus, appendMessageCorpus, MESSAGE_TEXT_LIMIT } from '../src/plugin.mjs';
import { mkdtempSync as mkTmp2, readFileSync as readF2, existsSync as existsF2, rmSync as rmT2, readdirSync } from 'node:fs';
import { tmpdir as tmp2 } from 'node:os';
import path2 from 'node:path';

test('T268 ①: collectMessages=false ⇒ 完全不写文件（配置为唯一开关）', () => {
  const dir = mkTmp2(path2.join(tmp2(), 'kifuin-t268-'));
  try {
    // 关闭时不调用 appendMessageCorpus；这里断言"没被调用"的等价事实：目录里没有文件
    const row = messageCorpusRow({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(row.messages.length, 1);
    assert.equal(existsF2(path2.join(dir, 'evidence', 'T268-messages.jsonl')), false);
  } finally { rmT2(dir, { recursive: true, force: true }); }
});

test('T268 ②: 写失败 ⇒ 只返回 false，不抛（采集不许拖垮注入）', () => {
  const boom = { mkdirSync() { throw new Error('EACCES'); }, appendFileSync() { throw new Error('EACCES'); } };
  assert.equal(appendMessageCorpus('D:/nope', messageCorpusRow({ messages: [{ role: 'user', content: 'x' }] }), { fsImpl: boom }), false);
});

test('T268 ③: 语料行形状正确（role/text/episode/scopeKey/at）+ 超长截断 + 脱敏', () => {
  const long = 'x'.repeat(MESSAGE_TEXT_LIMIT + 50);
  const row = messageCorpusRow({
    episode: 'ep-1', scopeKey: 'w:d:/work/demo', at: 1,
    messages: [{ role: 'user', content: ('api_key=' + ['sk', 'abcdefghijklmnop1234'].join('-')) }, { role: 'assistant', content: long }],
  });
  assert.equal(row.episode, 'ep-1');
  assert.equal(row.scopeKey, 'w:d:/work/demo');
  assert.equal(row.at, 1);
  assert.equal(row.messages[0].role, 'user');
  assert.ok(row.messages[0].text.toUpperCase().includes('REDACTED'));
  assert.equal(row.messages[1].text.length, MESSAGE_TEXT_LIMIT);
  assert.equal(row.messages[1].truncated, true);
  assert.equal(redactForCorpus('token=abc').includes('abc'), false);
});

// ---------------------------------------------------------------- T282（写入根收口到 sidecar）
import { messageCorpusPath } from '../src/plugin.mjs';

test('T282 ①: 语料落在 <storeRoot>/corpus/messages.jsonl（由 store root 推导，不写死仓库路径）', () => {
  const storeRoot = path2.join(tmp2(), 'kifuin-t282-store');
  const target = messageCorpusPath(storeRoot);
  assert.equal(target, path2.join(storeRoot, 'corpus', 'messages.jsonl'));
  assert.ok(target.startsWith(storeRoot), '必须落在 store root 之下');
  assert.equal(target.includes('长期记忆系统'), false, '不许拼进仓库路径');
});

test('T282 ② tombstone: 写入只落 store root，**仓库目录里不出现新文件**', () => {
  const repoEvidence = path2.join(process.cwd(), 'evidence');
  const before = new Set(existsF2(repoEvidence) ? readdirSync(repoEvidence) : []);
  const storeRoot = mkTmp2(path2.join(tmp2(), 'kifuin-t282-write-'));
  try {
    const ok = appendMessageCorpus(storeRoot, messageCorpusRow({ episode: 'ep-t282', messages: [{ role: 'user', content: '你好' }] }));
    assert.equal(ok, true, '写 store root 必须成功');
    assert.equal(existsF2(messageCorpusPath(storeRoot)), true, '语料必须落在 sidecar');
    const after = new Set(existsF2(repoEvidence) ? readdirSync(repoEvidence) : []);
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `仓库 evidence/ 不许新增文件，实际新增：${added.join(',')}`);
  } finally { rmT2(storeRoot, { recursive: true, force: true }); }
});

test('T282 ③: 写失败静默降级（返回 false，不抛）', () => {
  const boom = { mkdirSync() { throw new Error('EACCES'); }, appendFileSync() { throw new Error('EACCES'); } };
  assert.equal(appendMessageCorpus('D:/nope-t282', messageCorpusRow({ messages: [{ role: 'user', content: 'x' }] }), { fsImpl: boom }), false);
});

test('T282 ④: 真实 pre-step 语料只写 <storeRoot>/corpus/messages.jsonl', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot, collectMessages: true, probeValidity: false }));
    await runHook({
      hooks,
      payload: { agent: { session }, messages: [userMessage('yaml 装不上')] },
      decision: enterDecision([userMessage('yaml 装不上')]),
    });
    const corpus = messageCorpusPath(storeRoot);
    assert.equal(existsSync(corpus), true);
    const rows = readFileSync(corpus, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messages.at(-1).text, 'yaml 装不上');
    assert.equal(existsSync(path.join(workspace, 'evidence', 'T268-messages.jsonl')), false);
  } finally {
    cleanup();
  }
});

test('T365 卡样本必须带 signalPreview（没有信号就无法审计"这张卡是否该注入"）', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync('src/plugin.mjs', 'utf8'));
  assert.ok(src.includes('signalPreview:'), '卡样本必须带 signalPreview 字段');
  // 必须在外层作用域用 lastUserText 现取（外层没有 decidePreStep 的局部 text 变量）
  assert.ok(src.includes("signalPreview: String(lastUserText(payload?.messages) ?? '').slice(0, 160)"),
    '信号必须来自 lastUserText(payload.messages)（外层作用域），不能用 decidePreStep 的局部 text');
});

// ---------------------------------------------------------------------------
// T3 ⑪ · 三级交付**接进生产链路**（wiring）
//
// 判据只有一份（`src/rooms/inject.mjs` 的 `isPointerCandidate`），"能不能生效"由插件配置决定。
// 这一条钉住**唯一接线点**（`decidePreStep` 里的 `pointerTier: config.pointerTier === true`）：
// 删掉那一行 ⇒ 配置键静默失效 ⇒ 两条断言互换 ⇒ 本测试红（tombstone）。
// ---------------------------------------------------------------------------
test('T3 ⑪ 接线: 配置 pointerTier 真的走到卡片上（true ⇒ 指针行；false ⇒ 逐字原文）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    /** 跑一次 pre-step，返回真正注入的那条消息的正文。 */
    const injectedTextOf = async (over) => {
      const { ctx, hooks } = makeCtx();
      const { session } = makeSession(workspace);
      apply(ctx, baseConfig({ storeRoot, ...over }));
      const claimed = [userMessage('yaml 装不上')];
      const out = await runHook({ hooks, payload: { agent: { session }, messages: claimed }, decision: enterDecision([...claimed]) });
      assert.equal(out.messages.length, 2, '有命中就必须注入（否则这条测试什么都没测到）');
      return messageText(out.messages[1]);
    };

    // 显式关：卡片给逐字原文（0.8.46 行为）
    const off = await injectedTextOf({ pointerTier: false, probeValidity: false });
    assert.ok(off.includes('Error: boom'), `显式关 ⇒ 给逐字原文：${off}`);
    assert.ok(!off.includes('原文未给'), `显式关时一个字都不许变：${off}`);

    // 显式开：同一批输入只剩坐标（episode + seq + 日期）
    const on = await injectedTextOf({ pointerTier: true, probeValidity: false });
    assert.ok(on.includes('1 局支撑 · 原文未给'), `接线后 ⇒ 只给指针：${on}`);
    assert.ok(!on.includes('Error: boom'), `指针行的断言正文不许进注入文本：${on}`);
    assert.ok(on.includes('ep-aaaaaaa1'), '坐标（episode）不许省');
    assert.ok(on.includes('seq 30'), '坐标（seq）不许省');
    assert.ok(on.includes('2026-10-21'), '日期（occurredAt）不许省');
    assert.ok(on.includes('<memory-ledger>'), '指针行仍是一张展开的卡（不是零注入）');
  } finally {
    cleanup();
  }
});

test('T3 ⑪: sanitizeConfig 认 pointerTier（布尔键；类型不对退回默认，不静默接受垃圾）', () => {
  assert.equal(sanitizeConfig({ pointerTier: false }).pointerTier, false, '显式关必须生效');
  assert.equal(sanitizeConfig({ pointerTier: true }).pointerTier, true);
  assert.equal(sanitizeConfig({ pointerTier: 'yes' }).pointerTier, DEFAULT_CONFIG.pointerTier, '类型不对 ⇒ 退回默认');
  assert.equal(sanitizeConfig({}).pointerTier, DEFAULT_CONFIG.pointerTier, '未设置 ⇒ 默认值（单一来源）');
});
