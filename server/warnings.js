// 采购资源预警中心
// 只读分析模块：复用 inventory.getAvailability（实时余量）与 helpers.calcFinance（财务），
// 不改变任何库存/占用/计调数据。
const db = require('./db');
const inv = require('./inventory');
const { nightsBetween, round2 } = require('./helpers');

const RESOURCE_TYPES = ['航班', '酒店', '地接'];
const LEVELS = ['高', '中', '低'];

// 预警类型：
//  low_stock       未来窗口内低余量资源
//  stale_pending   待确认超过指定时长的占用
//  stopped_active  资源已停售但仍有有效占用
//  price_drift     已确认成本快照价与当前采购价明显偏离
//  tour_unconfirmed 临近出发但航班/酒店/地接未确认完整的团队
const WARNING_TYPES = ['low_stock', 'stale_pending', 'stopped_active', 'price_drift', 'tour_unconfirmed'];
const TYPE_LABEL = {
  low_stock: '低余量',
  stale_pending: '待确认超时',
  stopped_active: '停售仍占用',
  price_drift: '成本价偏离',
  tour_unconfirmed: '临行未确认'
};

const DEFAULTS = {
  horizonDays: 60,        // 未来预警窗口
  lowStockRatio: 0.2,     // 余量 ≤20% 为低余量
  soldoutRatio: 0,        // 余量 0 为售罄
  staleHours: 24,         // 待确认超过 24 小时
  staleHighHours: 72,     // 超过 72 小时升级为高风险
  driftRatio: 0.1,        // 快照价与当前采购价偏离 ≥10%
  driftHighRatio: 0.3,    // 偏离 ≥30% 为高风险
  tourDueDays: 7          // 出发前 7 天内的团队检查确认完整度
};

function localDateStr(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function hoursBetween(createdAt, now) {
  if (!createdAt) return null;
  // created_at 形如 "2026-09-20 13:45:30"（UTC，datetime('now') 写入）
  const t = Date.parse(String(createdAt).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3600000;
}

/* ---------------- 预警 1：未来窗口内低余量资源 ---------------- */
// 复用 inv.getAvailability 的逐日余量；酒店取窗口内服务日的最小余量。
function lowStockWarnings(horizonEnd, cfg) {
  const out = [];
  const resources = db.prepare('SELECT * FROM resources WHERE service_date <= ?').all(horizonEnd);
  for (const r of resources) {
    const av = inv.getAvailability(r.id);
    if (!av) continue;
    // 仅统计窗口内（今天及以后）的服务日；资源全部服务日已过期则跳过
    const days = av.daily.filter(d => d.date <= horizonEnd);
    if (!days.length) continue;
    const held = days.some(d => d.held > 0);
    if (!held) continue; // 没有任何有效占用的空闲库存不预警
    const worst = days.reduce((m, d) => Math.min(m, d.available), Infinity);
    const qty = r.qty;
    const tightDays = days.filter(d => d.available <= qty * cfg.lowStockRatio);
    if (worst > qty * cfg.lowStockRatio) continue;

    const soldout = worst <= cfg.soldoutRatio;
    out.push({
      warning_type: 'low_stock',
      level: soldout ? '高' : '中',
      resource_type: r.type,
      resource_id: r.id,
      resource_name: r.name,
      supplier_id: r.supplier_id,
      service_date: tightDays[0]?.date || days[0].date,
      end_date: r.type === '酒店' ? r.end_date : null,
      tour_id: null,
      title: `${r.type}「${r.name}」${soldout ? '窗口内已售罄' : '余量紧张'}`,
      detail: soldout
        ? `未来 ${cfg.horizonDays} 天内存在余量为 0 的日期：${tightDays.filter(d => d.available === 0).map(d => d.date.slice(5)).join('、')}，请尽快补货或协调释放`
        : `窗口内最低余量 ${worst}/${qty}（≤${Math.round(cfg.lowStockRatio * 100)}%），紧张日期：${tightDays.map(d => d.date.slice(5)).join('、')}`,
      metrics: {
        available: worst, qty,
        ratio: round2(worst / qty),
        pending: av.pending, confirmed: av.confirmed,
        tight_dates: tightDays.map(d => d.date)
      }
    });
  }
  return out;
}

/* ---------------- 预警 2：待确认超过 24 小时的占用 ---------------- */
function stalePendingWarnings(horizonEnd, cfg, now) {
  const rows = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name, r.supplier_id,
           s.name AS supplier_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN suppliers s ON s.id = r.supplier_id
    WHERE a.status='待确认' AND a.start_date <= ?`).all(horizonEnd);
  const out = [];
  for (const a of rows) {
    const hours = hoursBetween(a.created_at, now);
    if (hours === null || hours < cfg.staleHours) continue;
    out.push({
      warning_type: 'stale_pending',
      level: hours >= cfg.staleHighHours ? '高' : '中',
      resource_type: a.resource_type,
      resource_id: a.resource_id,
      resource_name: a.resource_name,
      supplier_id: a.supplier_id,
      service_date: a.start_date,
      end_date: a.end_date,
      tour_id: a.tour_id,
      allocation_id: a.id,
      title: `占用 #${a.id} 待确认已 ${Math.floor(hours)} 小时`,
      detail: `${a.tour_code}（${a.tour_name}）占用「${a.resource_name}」${a.qty}${a.resource_type === '航班' ? ' 座' : a.resource_type === '酒店' ? ' 间' : ' 团'}，自 ${a.created_at} 起待确认，超过 ${cfg.staleHours} 小时未与供应商确认`,
      metrics: { hours: round2(hours), qty: a.qty, created_at: a.created_at }
    });
  }
  return out;
}

/* ---------------- 预警 3：资源已停售但仍有有效占用 ---------------- */
function stoppedActiveWarnings(horizonEnd, cfg) {
  const rows = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name, r.supplier_id,
           r.status AS resource_status, s.name AS supplier_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN suppliers s ON s.id = r.supplier_id
    WHERE a.status IN ('待确认','已确认') AND r.status='停售' AND a.start_date <= ?`).all(horizonEnd);
  const out = [];
  for (const a of rows) {
    out.push({
      warning_type: 'stopped_active',
      level: '高',
      resource_type: a.resource_type,
      resource_id: a.resource_id,
      resource_name: a.resource_name,
      supplier_id: a.supplier_id,
      service_date: a.start_date,
      end_date: a.end_date,
      tour_id: a.tour_id,
      allocation_id: a.id,
      title: `资源「${a.resource_name}」已停售，仍有${a.status === '已确认' ? '已确认' : '待确认'}占用`,
      detail: `${a.tour_code}（${a.tour_name}）持有 ${a.qty}${a.resource_type === '航班' ? ' 座' : a.resource_type === '酒店' ? ' 间' : ' 团'}有效占用（${a.start_date}${a.end_date ? '~' + a.end_date : ''}），停售后补货通道关闭，需尽快替代采购或与供应商特批`,
      metrics: { qty: a.qty, allocation_status: a.status }
    });
  }
  return out;
}

/* ---------------- 预警 4：成本快照价明显高于/低于当前采购价 ---------------- */
// 仅评估已确认占用（确认时锁定快照价）；酒店按间夜单价对比，倍数=晚数
function priceDriftWarnings(horizonEnd, cfg) {
  const rows = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name, r.supplier_id,
           r.unit_price AS current_price, s.name AS supplier_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN suppliers s ON s.id = r.supplier_id
    WHERE a.status='已确认' AND a.start_date <= ?`).all(horizonEnd);
  const out = [];
  for (const a of rows) {
    const snap = Number(a.price_snapshot);
    const cur = Number(a.current_price);
    if (!(snap > 0) || !(cur >= 0)) continue;
    const diff = round2(cur - snap);
    const ratio = (cur - snap) / snap;
    if (Math.abs(ratio) < cfg.driftRatio) continue;
    const nights = a.resource_type === '酒店' ? nightsBetween(a.start_date, a.end_date) : 1;
    const impact = round2(diff * a.qty * nights);
    out.push({
      warning_type: 'price_drift',
      level: Math.abs(ratio) >= cfg.driftHighRatio ? '高' : '中',
      resource_type: a.resource_type,
      resource_id: a.resource_id,
      resource_name: a.resource_name,
      supplier_id: a.supplier_id,
      service_date: a.start_date,
      end_date: a.end_date,
      tour_id: a.tour_id,
      allocation_id: a.id,
      title: diff > 0
        ? `「${a.resource_name}」当前采购价高于快照价 ${(ratio * 100).toFixed(1)}%`
        : `「${a.resource_name}」当前采购价低于快照价 ${(-ratio * 100).toFixed(1)}%（团队可能锁贵了）`,
      detail: `快照价 ¥${snap} → 当前采购价 ¥${cur}，${a.tour_code} 确认 ${a.qty}${a.resource_type === '航班' ? ' 座' : a.resource_type === '酒店' ? ' 间×' + nights + '晚' : ' 团'}；${diff > 0 ? '若重新采购将多支出' : '按现价口径该团成本可能多计'}约 ¥${Math.abs(impact)}`,
      metrics: {
        price_snapshot: snap, current_price: cur,
        diff, drift_ratio: round2(ratio), cost_impact: impact,
        direction: diff > 0 ? 'up' : 'down'
      }
    });
  }
  return out;
}

/* ---------------- 预警 5：临近出发但航班/酒店/地接未确认完整 ---------------- */
// 复用 calcFinance 的同一批计调表（与毛利估算数据源一致）：
// 航班去/回程齐全且全部 confirmed；酒店至少一条且全部 confirmed；地接至少一条且 confirmed。
function tourUnconfirmedWarningsImpl(today, cfg) {
  const dueEnd = addDays(today, cfg.tourDueDays);
  const tours = db.prepare(`
    SELECT t.*, p.name AS product_name
    FROM tours t JOIN products p ON p.id = t.product_id
    WHERE t.departure_date >= ? AND t.departure_date <= ? AND t.status != '已结束'
    ORDER BY t.departure_date`).all(today, dueEnd);
  const out = [];
  for (const t of tours) {
    const days = Math.round((new Date(t.departure_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
    const flights = db.prepare('SELECT * FROM flight_bookings WHERE tour_id=?').all(t.id);
    const hotels = db.prepare('SELECT * FROM hotel_bookings WHERE tour_id=?').all(t.id);
    const locals = db.prepare('SELECT * FROM local_services WHERE tour_id=?').all(t.id);

    const checks = [
      {
        type: '航班',
        missing: flights.length === 0
          ? ['尚未安排任何航班切位']
          : [
              !flights.some(f => f.direction !== '回程') ? '缺去程航班' : null,
              !flights.some(f => f.direction === '回程') ? '缺回程航班' : null,
              ...flights.filter(f => !f.confirmed).map(f => `${f.flight_no}（${f.direction}）待确认`)
            ].filter(Boolean)
      },
      {
        type: '酒店',
        missing: hotels.length === 0
          ? ['尚未安排任何控房']
          : hotels.filter(h => !h.confirmed).map(h => `${h.hotel_name} ${h.check_in}~${h.check_out} 待确认`)
      },
      {
        type: '地接',
        missing: locals.length === 0
          ? ['尚未安排地接社']
          : locals.filter(l => !l.confirmed).map(l => `${l.agency_name} 待确认`)
      }
    ];

    for (const c of checks) {
      if (!c.missing.length) continue;
      out.push({
        warning_type: 'tour_unconfirmed',
        level: days <= 2 ? '高' : days <= 4 ? '中' : '低',
        resource_type: c.type,
        resource_id: null,
        resource_name: null,
        supplier_id: null,
        service_date: t.departure_date,
        end_date: t.return_date || null,
        tour_id: t.id,
        tour_code: t.code,
        title: `${t.code} ${c.type}未确认完整（${days === 0 ? '今天出发' : days + ' 天后出发'}）`,
        detail: `${t.product_name}：${c.missing.join('、')}`,
        metrics: { days_to_departure: days, missing: c.missing }
      });
    }
  }
  return out;
}

/* ---------------- 汇总与筛选 ---------------- */
function collectWarnings(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts.config };
  const now = opts.now || new Date();
  const today = localDateStr(now);
  const horizonDays = Number.isFinite(Number(cfg.horizonDays)) ? Number(cfg.horizonDays) : DEFAULTS.horizonDays;
  cfg.horizonDays = horizonDays;
  const horizonEnd = addDays(today, horizonDays);

  const types = opts.types && opts.types.length ? opts.types : WARNING_TYPES;
  let list = [];
  if (types.includes('low_stock')) list = list.concat(lowStockWarnings(horizonEnd, cfg));
  if (types.includes('stale_pending')) list = list.concat(stalePendingWarnings(horizonEnd, cfg, now));
  if (types.includes('stopped_active')) list = list.concat(stoppedActiveWarnings(horizonEnd, cfg));
  if (types.includes('price_drift')) list = list.concat(priceDriftWarnings(horizonEnd, cfg));
  if (types.includes('tour_unconfirmed')) list = list.concat(tourUnconfirmedWarningsImpl(today, cfg));

  // 补公共字段
  const supName = (id) => id ? db.prepare('SELECT name FROM suppliers WHERE id=?').get(id)?.name || '' : '';
  list.forEach((w, i) => {
    w.id = `${w.warning_type}-${w.resource_id || 't' + w.tour_id}-${w.allocation_id || w.resource_type}-${i}`;
    w.type_label = TYPE_LABEL[w.warning_type];
    w.supplier_name = w.supplier_id ? supName(w.supplier_id) : '';
  });

  // 筛选（等级筛选除外，先应用其余条件，以便等级汇总卡片展示各等级数量）
  const f = opts.filter || {};
  if (f.resource_type) list = list.filter(w => w.resource_type === f.resource_type);
  if (f.supplier_id) list = list.filter(w => String(w.supplier_id) === String(f.supplier_id));
  if (f.date_from) list = list.filter(w => (w.service_date || '') >= f.date_from);
  if (f.date_to) list = list.filter(w => (w.service_date || '') <= f.date_to);

  const levelRank = { 高: 0, 中: 1, 低: 2 };
  list.sort((a, b) =>
    levelRank[a.level] - levelRank[b.level] ||
    (a.service_date || '').localeCompare(b.service_date || '') ||
    a.warning_type.localeCompare(b.warning_type));

  // 等级/类型汇总基于等级筛选前的列表（随类型/供应商/日期筛选联动）
  const summary = { 高: 0, 中: 0, 低: 0 };
  const byType = Object.fromEntries(WARNING_TYPES.map(t => [t, 0]));
  for (const w of list) {
    summary[w.level]++;
    byType[w.warning_type]++;
  }
  if (f.level) list = list.filter(w => w.level === f.level);

  return { generated_at: now.toISOString(), today, horizon_days: horizonDays, summary, by_type: byType, total: summary['高'] + summary['中'] + summary['低'], warnings: list };
}

module.exports = {
  RESOURCE_TYPES, LEVELS, WARNING_TYPES, TYPE_LABEL, DEFAULTS,
  localDateStr, addDays, hoursBetween,
  collectWarnings
};
