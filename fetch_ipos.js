/**
 * fetch_ipos.js  —  每日抓取美股新股数据,生成 data.json
 * --------------------------------------------------------------
 * 数据源(全部免费):
 *   1) Finnhub 免费档:IPO 日历 / 实时行情 / 公司概况 / 基本面
 *      免费额度 60 次/分钟,IPO 日历是免费端点。注册拿 key:https://finnhub.io
 *   2) stooq 免费 CSV:日线历史(无需 key),用于算「首日涨幅」「连涨天数」「成交量」
 *
 * 运行环境:Node 18+(GitHub Actions 的 ubuntu-latest 自带 Node 20,无需 npm install)
 * 用法:  FINNHUB_KEY=你的key  node fetch_ipos.js
 * 产物:  ./data.json
 * --------------------------------------------------------------
 * 注意:免费数据有取舍——
 *   · 市值/市盈率/流通股 来自 Finnhub 概况,个别新股可能缺失(显示 — )
 *   · 类型(IPO/SPAC/ETF/REIT/ADR)用启发式判断,非 100% 精准,可按需补规则
 *   · ETF 一般不走 IPO 流程,IPO 日历里主要是普通 IPO 和 SPAC
 */

const FINNHUB_KEY = process.env.FINNHUB_KEY;
if (!FINNHUB_KEY) { console.error('缺少环境变量 FINNHUB_KEY'); process.exit(1); }

const LOOKBACK_DAYS = 120;        // 回看多少天的新股
const FH = 'https://finnhub.io/api/v1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jget(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ipo-center/1.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.json();
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }

/* 解析 IPO 日历里的发行价(可能是 "18" 或 "18-20") */
function parseIpoPrice(p) {
  if (p == null) return null;
  const nums = String(p).match(/[\d.]+/g);
  if (!nums) return null;
  if (nums.length === 1) return parseFloat(nums[0]);
  return (parseFloat(nums[0]) + parseFloat(nums[1])) / 2; // 区间取中值
}

/* 类型启发式判断 */
function classify(name, profile) {
  const n = (name || '').toLowerCase();
  const industry = (profile?.finnhubIndustry || '').toLowerCase();
  const country = profile?.country || '';
  if (/acquisition (corp|co|company)|blank check/.test(n)) return 'SPAC';
  if (/\betf\b|index fund|exchange.?traded/.test(n)) return 'ETF';
  if (/reit|realty|real estate trust|properties trust/.test(n) || industry.includes('reit')) return 'REIT';
  if (/\badr\b|american depositary|sponsored adr/.test(n)) return 'ADR';
  if (country && country !== 'US') return 'ADR'; // 非美国公司在美上市,多为 ADR
  return 'IPO';
}

/* 从 stooq 拉日线历史:返回 [{date, close, volume}, ...] 升序 */
async function stooqHistory(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text || text.startsWith('<') || text.includes('N/D')) return [];
  const lines = text.trim().split('\n').slice(1); // 跳过表头
  const rows = [];
  for (const line of lines) {
    const [date, open, high, low, close, volume] = line.split(',');
    const c = parseFloat(close), v = parseFloat(volume);
    if (!isNaN(c)) rows.push({ date, close: c, volume: isNaN(v) ? 0 : v });
  }
  return rows;
}

/* 连涨天数:从最新往前数连续上涨的交易日 */
function upStreak(hist) {
  let streak = 0;
  for (let i = hist.length - 1; i > 0; i--) {
    if (hist[i].close > hist[i - 1].close) streak++;
    else break;
  }
  return streak;
}

async function main() {
  const today = new Date();
  const from = new Date(today.getTime() - LOOKBACK_DAYS * 86400000);

  // 1) 拉 IPO 日历
  const cal = await jget(`${FH}/calendar/ipo?from=${fmtDate(from)}&to=${fmtDate(today)}&token=${FINNHUB_KEY}`);
  let list = (cal.ipoCalendar || []).filter(x =>
    x.symbol && x.symbol.length <= 6 &&
    (x.status === 'priced' || x.status === 'listed') // 只要已上市/已定价
  );
  // 去重(同一 symbol 取最早一条)
  const seen = new Map();
  for (const x of list) if (!seen.has(x.symbol)) seen.set(x.symbol, x);
  list = [...seen.values()];

  console.log(`IPO 日历命中 ${list.length} 只,开始逐个抓取明细…`);
  const items = [];

  for (const ipo of list) {
    const sym = ipo.symbol;
    try {
      const ipoPrice = parseIpoPrice(ipo.price);

      // 行情
      const quote = await jget(`${FH}/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
      await sleep(250);
      // 概况(市值/流通股/行业/国家)
      const profile = await jget(`${FH}/stock/profile2?symbol=${sym}&token=${FINNHUB_KEY}`);
      await sleep(250);
      // 基本面(市盈率)
      let pe = null;
      try {
        const m = await jget(`${FH}/stock/metric?symbol=${sym}&metric=all&token=${FINNHUB_KEY}`);
        pe = m?.metric?.peTTM ?? m?.metric?.peNormalizedAnnual ?? null;
        await sleep(250);
      } catch (_) {}

      // 历史(stooq)
      const hist = await stooqHistory(sym);
      await sleep(300);

      const price = quote.c || (hist.length ? hist[hist.length - 1].close : null);
      const dayChange = quote.dp != null ? quote.dp / 100 : null;

      // 首日涨幅:首个交易日收盘 vs 发行价
      let firstDayChange = null;
      if (ipoPrice && hist.length) {
        firstDayChange = (hist[0].close - ipoPrice) / ipoPrice;
      }
      // 累计涨幅:现价 vs 发行价
      let cumChange = (ipoPrice && price) ? (price - ipoPrice) / ipoPrice : null;

      // 成交量/成交额/换手率
      const lastVol = hist.length ? hist[hist.length - 1].volume : null;
      const sharesOut = profile.shareOutstanding ? profile.shareOutstanding * 1e6 : null; // 百万股 -> 股
      const turnover = (lastVol && price) ? lastVol * price : null;
      const turnoverRate = (lastVol && sharesOut) ? lastVol / sharesOut : null;

      // 市值:优先用概况,否则 现价 * 流通股
      let marketCap = profile.marketCapitalization ? profile.marketCapitalization * 1e6 : null;
      if (!marketCap && price && sharesOut) marketCap = price * sharesOut;

      items.push({
        date: ipo.date,
        name: ipo.name || profile.name || sym,
        symbol: sym,
        type: classify(ipo.name || profile.name, profile),
        price,
        ipo_price: ipoPrice,
        market_cap: marketCap,
        first_day_change: firstDayChange,
        cum_change: cumChange,
        day_change: dayChange,
        up_streak: hist.length ? upStreak(hist) : 0,
        volume: lastVol,
        turnover,
        turnover_rate: turnoverRate,
        pe: (pe != null && isFinite(pe)) ? Number(pe.toFixed(2)) : null,
      });
      console.log(`  ✓ ${sym}`);
    } catch (e) {
      console.log(`  ✗ ${sym}: ${e.message}`);
    }
  }

  const out = { updated_at: new Date().toISOString(), count: items.length, items };
  const fs = await import('fs');
  fs.writeFileSync('data.json', JSON.stringify(out, null, 2));
  console.log(`完成,写入 data.json,共 ${items.length} 只。`);
}

main().catch(e => { console.error(e); process.exit(1); });
