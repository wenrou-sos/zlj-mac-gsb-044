// 采购资源预警中心：只读扫描库存余量 / 占用时效 / 停售占用 / 成本快照偏离 / 临出发确认完整度。
// 不改动任何库存写路径；余量复用 inventory.getAvailability，金额复用 helpers 的 round2。
const db = require('./db');
const inv = require('./inventory');
const { round2 } = require('./helpers');

const LEVELS = ['高', '中', '低'];
const LEVEL_RANK = { 高: 0, 中: 1, 低: 2 };

const KINDS = {
  low_stock: '低余量资源',
  pending_timeout: '待确认超时',
  inactive_with_hold: '停售仍有占用',
  price_deviation: '成本快照偏离',
  departure_unconfirmed: '临出发未确认'
};

// 默认监控规则（均可通过查询参数覆盖）
const DEFAULTS = {
  days: 60,           // 低余量扫描窗口：未来 N 天
  pending_hours: 24,  // 待确认超过 N 小时预警
  depart_within: 7,   // 距出发 N 天检查航班/酒店/地接确认完整度
  depart_urgent: 3,   // 距出发 ≤ N 天升级为高风险
  deviation_pct: 10,  // 成本快照与当前采购价偏离 ≥ N% 预警
  low_stock_pct: 20   // 余量占比 ≤ N% 视为紧张
};

/* ---------------- 日期工具（本地时区） ---------------- */
function todayStr(now = new Date()) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayStr(d);
}
function diffDays(a, b) { // a - b 的天数
  return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
}
function hoursSince(dtStr, now) {
  if (!dtStr) return 0;
  return (now - new Date(String(dtStr).replace(' ', 'T'))) / 3600000;
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/* ---------------- 1. 未来 N 天低余量资源 ---------------- */
function scanLowStock(cfg, today, horizon, push) {
  const resources = db.prepare(`
    SELECT r.*, s.name AS supplier_name
    FROM resources r JOIN suppliers s ON s.id = r.supplier_id
  `).all();

  for (const r of resources) {
    if (r.status !== '在售') continue; // 停售资源由 inactive_with_hold 覆盖
    // 资源服务窗口与 [today, horizon] 有交集才扫描
    const winEnd = r.type === '酒店'
      ? (inv.dateList(r.service_date, r.end_date).pop() || r.service_date)
      : r.service_date;
    if (winEnd < today || r.service_date > horizon) continue;

    const av = inv.getAvailability(r.id);
    const scope = av.daily.filter(d => d.date >= today && d.date <= horizon);
    if (!scope.length) continue;
    const worst = scope.reduce((m, d) => (d.available < m.available ? d : m), scope[0]);
    const ratioPct = worst.qty > 0 ? round2(worst.available / worst.qty * 100) : 0;

    let level = null;
    if (worst.available <= 0) level = '高';
    else if (ratioPct <= cfg.low_stock_pct) level = '中';
    if (!level) continue;

    push({
      id: `low_stock:res:${r.id}`,
      kind: 'low_stock', level,
      resource_type: r.type,
      title: `「${r.name}」${worst.date} ${worst.available <= 0 ? '已售罄' : '余量紧张'}`,
      detail: `${r.service_date}${r.end_date ? ' ~ ' + r.end_date : ''} 期间最差一日（${worst.date}）`
        + `余量 ${worst.available}/${worst.qty}（待确认 ${worst.pending} · 已确认 ${worst.confirmed}）`,
      suggestion: worst.available <= 0
        ? '建议立即追加采购、协调供应商放位，或释放无效占用'
        : '建议提前锁量或准备替代资源，避免临期无位可切',
      date: worst.date,
      resource_id: r.id,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      metrics: { available: worst.available, qty: worst.qty, held: worst.held, ratio_pct: ratioPct }
    });
  }
}

/* ---------------- 2. 待确认超过 N 小时的占用 ---------------- */
function scanPendingTimeout(cfg, today, now, push) {
  const rows = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name,
      s.id AS supplier_id, s.name AS supplier_name,
      t.code AS tour_code, t.departure_date, p.name AS product_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN suppliers s ON s.id = r.supplier_id
    JOIN tours t ON t.id = a.tour_id
    JOIN products p ON p.id = t.product_id
    WHERE a.status = '待确认'
  `).all();

  for (const a of rows) {
    const hours = hoursSince(a.created_at, now);
    if (hours < cfg.pending_hours) continue;
    const daysLeft = diffDays(a.departure_date, today);
    let level = hours >= cfg.pending_hours * 3 ? '高' : '中';
    if (daysLeft >= 0 && daysLeft <= cfg.depart_urgent) level = '高'; // 临近出发仍未确认，升级
    push({
      id: `pending_timeout:alloc:${a.id}`,
      kind: 'pending_timeout', level,
      resource_type: a.resource_type,
      title: `占用 #${a.id} 待确认已 ${Math.floor(hours)} 小时`,
      detail: `${a.tour_code}（${a.product_name}）占用「${a.resource_name}」×${a.qty}，`
        + `自 ${a.created_at} 起未确认；团队 ${a.departure_date} 出发（${daysLeft >= 0 ? `余 ${daysLeft} 天` : '已过期'}）`,
      suggestion: '请尽快向供应商确认或释放占用，避免占而不用影响他人收客',
      date: a.start_date,
      resource_id: a.resource_id,
      allocation_id: a.id,
      tour_id: a.tour_id,
      tour_code: a.tour_code,
      supplier_id: a.supplier_id,
      supplier_name: a.supplier_name,
      metrics: { hours: Math.floor(hours), qty: a.qty, days_left: daysLeft }
    });
  }
}

/* ---------------- 3. 资源已停售但仍有有效占用 ---------------- */
function scanInactiveWithHold(cfg, push) {
  const rows = db.prepare(`
    SELECT r.*, s.name AS supplier_name,
      COUNT(a.id) AS alloc_cnt,
      SUM(CASE WHEN a.status='已确认' THEN 1 ELSE 0 END) AS confirmed_cnt,
      SUM(CASE WHEN a.status='待确认' THEN 1 ELSE 0 END) AS pending_cnt,
      COALESCE(SUM(a.qty), 0) AS total_qty
    FROM resources r
    JOIN suppliers s ON s.id = r.supplier_id
    JOIN resource_allocations a ON a.resource_id = r.id AND a.status IN ('待确认','已确认')
    WHERE r.status = '停售'
    GROUP BY r.id
  `).all();

  for (const r of rows) {
    const level = r.confirmed_cnt > 0 ? '高' : '中';
    push({
      id: `inactive_with_hold:res:${r.id}`,
      kind: 'inactive_with_hold', level,
      resource_type: r.type,
      title: `「${r.name}」已停售，仍有 ${r.alloc_cnt} 笔有效占用`,
      detail: `已确认 ${r.confirmed_cnt} 笔 · 待确认 ${r.pending_cnt} 笔，合计 ${r.total_qty} 件；`
        + `停售后新占用已被拦截，但存量占用仍计入成本与库存`,
      suggestion: r.confirmed_cnt > 0
        ? '已确认占用涉及供应商成约，请尽快与对方核实履约或改签到其他资源'
        : '建议确认恢复在售，或释放待确认占用并迁移到替代资源',
      date: r.service_date,
      resource_id: r.id,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      metrics: { alloc_cnt: r.alloc_cnt, confirmed_cnt: r.confirmed_cnt, pending_cnt: r.pending_cnt, total_qty: r.total_qty }
    });
  }
}

/* ---------------- 4. 确认成本快照与当前采购价偏离 ---------------- */
function scanPriceDeviation(cfg, push) {
  const rows = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name, r.unit_price AS current_price,
      s.id AS supplier_id, s.name AS supplier_name,
      t.code AS tour_code, t.departure_date, p.name AS product_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN suppliers s ON s.id = r.supplier_id
    JOIN tours t ON t.id = a.tour_id
    JOIN products p ON p.id = t.product_id
    WHERE a.status = '已确认' AND r.unit_price != a.price_snapshot
  `).all();

  for (const a of rows) {
    if (!(a.price_snapshot > 0)) continue; // 快照价为 0 无法计算偏离度
    const pct = round2((a.current_price - a.price_snapshot) / a.price_snapshot * 100);
    if (Math.abs(pct) < cfg.deviation_pct) continue;
    const level = Math.abs(pct) >= cfg.deviation_pct * 3 ? '高' : '中';
    const up = pct > 0;
    push({
      id: `price_deviation:alloc:${a.id}`,
      kind: 'price_deviation', level,
      resource_type: a.resource_type,
      title: `「${a.resource_name}」采购价${up ? '上涨' : '下跌'} ${up ? '+' : ''}${pct}%`,
      detail: `${a.tour_code}（${a.product_name}）确认快照 ¥${a.price_snapshot}，`
        + `当前采购价 ¥${a.current_price}，偏离 ${up ? '+' : ''}${pct}%`,
      suggestion: up
        ? '已确认成本受快照保护；后续新占用将按高价计入，注意在收团队毛利'
        : '采购价低于快照价，可与供应商重新议价，或释放后重新占用以降低成本',
      date: a.start_date,
      resource_id: a.resource_id,
      allocation_id: a.id,
      tour_id: a.tour_id,
      tour_code: a.tour_code,
      supplier_id: a.supplier_id,
      supplier_name: a.supplier_name,
      metrics: { price_snapshot: a.price_snapshot, current_price: a.current_price, deviation_pct: pct }
    });
  }
}

/* ---------------- 5. 临近出发但航班/酒店/地接未确认完整 ---------------- */
function scanDepartureUnconfirmed(cfg, today, push) {
  const tours = db.prepare(`
    SELECT t.*, p.name AS product_name,
      (SELECT COUNT(*) FROM tourists tr WHERE tr.tour_id=t.id AND tr.status!='已退团') AS headcount
    FROM tours t JOIN products p ON p.id = t.product_id
    WHERE t.departure_date >= ? AND t.departure_date <= ?
      AND t.status NOT IN ('已结束', '已出团')
  `).all(today, addDays(today, cfg.depart_within));

  const CATS = [
    { type: '航班', table: 'flight_bookings', nameCol: 'flight_no' },
    { type: '酒店', table: 'hotel_bookings', nameCol: 'hotel_name' },
    { type: '地接', table: 'local_services', nameCol: 'agency_name' }
  ];

  for (const t of tours) {
    const daysLeft = diffDays(t.departure_date, today);
    const level = daysLeft <= cfg.depart_urgent ? '高' : '中';
    for (const c of CATS) {
      const rows = db.prepare(`SELECT * FROM ${c.table} WHERE tour_id=?`).all(t.id);
      const unconfirmed = rows.filter(r => !r.confirmed);
      if (rows.length > 0 && unconfirmed.length === 0) continue; // 该类别已确认完整
      const missing = rows.length === 0;
      push({
        id: `departure_unconfirmed:tour:${t.id}:${c.type}`,
        kind: 'departure_unconfirmed', level,
        resource_type: c.type,
        title: `${t.code} 距出发 ${daysLeft} 天，${c.type}${missing ? '未安排' : '未确认'}`,
        detail: missing
          ? `「${t.product_name}」${t.departure_date} 出发（在团 ${t.headcount}/${t.capacity} 人），尚无${c.type}计调记录`
          : `「${t.product_name}」${t.departure_date} 出发（在团 ${t.headcount}/${t.capacity} 人），`
            + `${unconfirmed.length}/${rows.length} 条${c.type}计调未确认：`
            + unconfirmed.map(r => r[c.nameCol]).join('、'),
        suggestion: missing
          ? `请尽快从资源池占位或手工录入${c.type}计调，并向供应商确认`
          : `请尽快向供应商确认${c.type}，锁定成本快照`,
        date: t.departure_date,
        tour_id: t.id,
        tour_code: t.code,
        metrics: { days_left: daysLeft, headcount: t.headcount, capacity: t.capacity, missing, unconfirmed_cnt: unconfirmed.length }
      });
    }
  }
}

/* ---------------- 主入口 ---------------- */
function computeAlerts(opts = {}) {
  const cfg = {
    days: num(opts.days, DEFAULTS.days),
    pending_hours: num(opts.pending_hours, DEFAULTS.pending_hours),
    depart_within: num(opts.depart_within, DEFAULTS.depart_within),
    depart_urgent: num(opts.depart_urgent, DEFAULTS.depart_urgent),
    deviation_pct: num(opts.deviation_pct, DEFAULTS.deviation_pct),
    low_stock_pct: num(opts.low_stock_pct, DEFAULTS.low_stock_pct)
  };
  const now = opts.now ? new Date(opts.now) : new Date();
  const today = todayStr(now);
  const horizon = addDays(today, cfg.days);

  const alerts = [];
  const push = (a) => alerts.push({
    kind_label: KINDS[a.kind],
    resource_id: null, allocation_id: null, tour_id: null, tour_code: null,
    supplier_id: null, supplier_name: null, resource_type: null,
    ...a
  });

  scanLowStock(cfg, today, horizon, push);
  scanPendingTimeout(cfg, today, now, push);
  scanInactiveWithHold(cfg, push);
  scanPriceDeviation(cfg, push);
  scanDepartureUnconfirmed(cfg, today, push);

  // 汇总基于全量（不受筛选影响），供工作台角标与预警页统计卡使用
  const summary = {
    total: alerts.length,
    by_level: Object.fromEntries(LEVELS.map(l => [l, alerts.filter(a => a.level === l).length])),
    by_kind: Object.fromEntries(Object.keys(KINDS).map(k => [k, alerts.filter(a => a.kind === k).length]))
  };

  // 筛选：风险等级 / 预警类型 / 资源类型 / 供应商 / 日期（服务日或出发日）
  const f = {
    level: opts.level || '',
    kind: opts.kind || '',
    type: opts.type || '',
    supplier_id: opts.supplier_id ? Number(opts.supplier_id) : null,
    from: opts.from || '',
    to: opts.to || ''
  };
  const list = alerts.filter(a =>
    (!f.level || a.level === f.level) &&
    (!f.kind || a.kind === f.kind) &&
    (!f.type || a.resource_type === f.type) &&
    (!f.supplier_id || a.supplier_id === f.supplier_id) &&
    (!f.from || (a.date && a.date >= f.from)) &&
    (!f.to || (a.date && a.date <= f.to))
  );
  list.sort((x, y) =>
    LEVEL_RANK[x.level] - LEVEL_RANK[y.level] ||
    String(x.date).localeCompare(String(y.date)) ||
    x.kind.localeCompare(y.kind) ||
    String(x.id).localeCompare(String(y.id))
  );

  return {
    generated_at: now.toLocaleString('zh-CN', { hour12: false }),
    params: cfg,
    summary,
    alerts: list
  };
}

module.exports = { KINDS, LEVELS, DEFAULTS, computeAlerts };
