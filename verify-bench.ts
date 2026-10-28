import { benchRecord, benchReport } from './server/bench.ts';

// 灌入 300005 个样本，跨越 CAP=300000 上限，验证环形覆盖且 report 正常
const t0 = Date.now();
for (let i = 0; i < 300005; i++) benchRecord((i % 7) + 0.01);
const dt = Date.now() - t0;

const r = benchReport();
console.log('样本写入耗时(ms):', dt, '(应远小于 O(n) 退化量级)');
console.log('report:', JSON.stringify(r));
// 期望：count=300005, p50≈3.0左右, max≈6.0, 无 NaN
const ok = r.count === 300005 && Number.isFinite(r.p50Ms) && Number.isFinite(r.p99Ms) && r.maxMs <= 6.01;
console.log(ok ? 'BENCH RING BUFFER OK' : 'BENCH FAIL');
process.exit(ok ? 0 : 1);
