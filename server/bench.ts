// 轻量基准埋点：记录每个"客户端意图"(出拳/行动)在服务器端的纯逻辑处理耗时与吞吐。
// 用途：简历/压测可量化"后端单意图响应时间(p50/p95/p99)"与"等效 QPS(已处理意图/秒)"。
// 设计为无外部依赖、低开销：耗时用 process.hrtime.bigint()，样本用定长 Float64Array 环形缓冲
// （替换原 Array + shift() 方案：原方案在样本达上限后每次记录需 O(CAP) 搬移，压测/长跑下严重退化）。
const CAP = 300000; // 环形上限
const buf = new Float64Array(CAP);
let head = 0;        // 下一个写入位置
let count = 0;       // 已写入样本数（<=CAP，超出后覆盖最旧）
let total = 0;       // 累计处理意图数
let winStart = Date.now(); // 吞吐窗口起点
let winCount = 0;    // 当前窗口内处理数
let lastTps = 0;     // 最近一次窗口吞吐(意图/秒)

// 记录一次意图的处理耗时(毫秒)
export function benchRecord(ms: number) {
  total++;
  winCount++;
  buf[head] = ms;
  head = (head + 1) % CAP;
  if (count < CAP) count++;
}

// 每个 metrics 周期调用一次：结算并重置吞吐窗口
export function benchTick() {
  const now = Date.now();
  const dt = (now - winStart) / 1000;
  lastTps = dt > 0 ? +(winCount / dt).toFixed(2) : 0;
  winStart = now;
  winCount = 0;
}

// 生成当前基准报告(百分位基于全部样本，不重置)
export function benchReport() {
  if (count === 0) {
    return { count: total, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, tps: lastTps };
  }
  // 按写入顺序展开为普通数组（最旧在前），再排序求百分位
  const arr = new Array<number>(count);
  for (let i = 0; i < count; i++) arr[i] = buf[(head - count + i + CAP) % CAP];
  arr.sort((a, b) => a - b);
  const n = count;
  const pct = (p: number) => arr[Math.min(n - 1, Math.floor(n * p))];
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    count: total,
    avgMs: +(sum / n).toFixed(3),
    p50Ms: +pct(0.5).toFixed(3),
    p95Ms: +pct(0.95).toFixed(3),
    p99Ms: +pct(0.99).toFixed(3),
    maxMs: +arr[n - 1].toFixed(3),
    tps: lastTps,
  };
}
