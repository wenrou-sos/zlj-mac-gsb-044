// 采购资源预警中心测试（只读分析，不改动库存逻辑）
// 运行：npm test（使用独立临时数据库，不影响 data/travel.db）
process.env.TRAVEL_DB_FILE = require('path').join(__dirname, '..', 'tmp-test', 'warnings-test.db');

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const testDir = path.join(__dirname, '..', 'tmp-test');
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const db = require('./db');
const inv = require('./inventory');
const w = require('./warnings');

const today = w.localDateStr();
const d = (n) => w.addDays(today, n);

function reset() {
  db.exec(`DELETE FROM resource_allocations; DELETE FROM resources; DELETE FROM suppliers;
    DELETE FROM notices; DELETE FROM other_costs; DELETE FROM local_services;
    DELETE FROM hotel_bookings; DELETE FROM flight_bookings; DELETE FROM tourists;
    DELETE FROM tours; DELETE FROM itinerary_days; DELETE FROM products;
    DELETE FROM sqlite_sequence;`);
}

function makeProductTour({ code = 'WT-001', depart = d(3), ret, capacity = 20, status = '收客中' } = {}) {
  db.prepare(`INSERT INTO products (name, days, departure_city, destination, price_double)
    VALUES ('预警测试线路', 3, '上海', '三亚', 3000)`).run();
  const pid = db.prepare('SELECT id FROM products ORDER BY id DESC LIMIT 1').get().id;
  const tid = db.prepare(`INSERT INTO tours (code, product_id, departure_date, return_date, capacity, status)
    VALUES (?,?,?,?,?,?)`).run(code, pid, depart, ret || d(6), capacity, status).lastInsertRowid;
  return tid;
}

function makeSupplier(name = '预警测试供应商', type = '航班') {
  return db.prepare("INSERT INTO suppliers (name, type) VALUES (?,?)").run(name, type).lastInsertRowid;
}
function makeResource({ sup, type = '航班', name = 'CA9999', service = d(10), end = null, qty = 100, price = 800, status = '在售' }) {
  return db.prepare(`INSERT INTO resources (supplier_id, type, name, service_date, end_date, qty, unit_price, status)
    VALUES (?,?,?,?,?,?,?,?)`).run(sup, type, name, service, end, qty, price, status).lastInsertRowid;
}
function setAllocCreated(id, isoLike) {
  // created_at 存储格式 UTC "YYYY-MM-DD HH:MM:SS"
  db.prepare('UPDATE resource_allocations SET created_at=? WHERE id=?').run(isoLike, id);
}

test('低余量：窗口内占用致余量 ≤20% 预警，售罄为高风险', () => {
  reset();
  const tid = makeProductTour();
  const sup = makeSupplier();
  const flight = makeResource({ sup, qty: 100 });
  inv.createAllocationTxn({ resource_id: flight, tour_id: tid, qty: 85, create_booking: 0 });
  let res = w.collectWarnings({ types: ['low_stock'] });
  let low = res.warnings.find(x => x.warning_type === 'low_stock' && x.resource_id === flight);
  assert.ok(low, '余量 15% 应产生低余量预警');
  assert.strictEqual(low.level, '中');
  assert.strictEqual(low.metrics.available, 15);

  // 再占用 16 → 售罄
  const tid2 = makeProductTour({ code: 'WT-002' });
  inv.createAllocationTxn({ resource_id: flight, tour_id: tid2, qty: 15, create_booking: 0 });
  res = w.collectWarnings({ types: ['low_stock'] });
  low = res.warnings.find(x => x.resource_id === flight);
  assert.strictEqual(low.level, '高');
  assert.strictEqual(low.metrics.available, 0);
});

test('低余量：无占用的空闲资源不预警；窗口外资源不预警', () => {
  reset();
  const sup = makeSupplier();
  makeResource({ sup, qty: 10 }); // 空闲
  const far = makeResource({ sup, name: 'CA-FAR', service: d(120), qty: 10 });
  const tid = makeProductTour({ depart: d(120) });
  inv.createAllocationTxn({ resource_id: far, tour_id: tid, qty: 10, create_booking:0 });
  const res = w.collectWarnings({ types: ['low_stock'] });
  assert.strictEqual(res.warnings.length, 0, '空闲资源与 60 天窗口外资源均不预警');
});

test('酒店低余量按窗口内逐日最小值取紧张日期', () => {
  reset();
  const tid = makeProductTour({ depart: d(5), ret: d(9) });
  const sup = makeSupplier('酒店供应商', '酒店');
  const hotel = makeResource({ sup, type: '酒店', name: '预警酒店', service: d(1), end: d(8), qty: 10, price: 500 });
  inv.createAllocationTxn({ resource_id: hotel, tour_id: tid, qty: 9, start_date: d(5), end_date: d(8), create_booking: 0 });
  const res = w.collectWarnings({ types: ['low_stock'] });
  const low = res.warnings.find(x => x.resource_id === hotel);
  assert.ok(low);
  assert.deepStrictEqual(low.metrics.tight_dates, [d(5), d(6), d(7)]);
  assert.strictEqual(low.metrics.available, 1);
});

test('待确认超时：超 24h 中风险，超 72h 高风险，已释放不预警', () => {
  reset();
  const tid = makeProductTour();
  const sup = makeSupplier();
  const r = makeResource({ sup });
  const a = inv.createAllocationTxn({ resource_id: r, tour_id: tid, qty: 5, create_booking: 0 }).allocation;
  const now = new Date();
  // 25 小时前
  setAllocCreated(a.id, new Date(now.getTime() - 25 * 3600e3).toISOString().slice(0, 19));
  let res = w.collectWarnings({ types: ['stale_pending'], now });
  let stale = res.warnings.find(x => x.allocation_id === a.id);
  assert.ok(stale);
  assert.strictEqual(stale.level, '中');
  assert.ok(stale.metrics.hours >= 24 && stale.metrics.hours < 26);

  // 73 小时前 → 高
  setAllocCreated(a.id, new Date(now.getTime() - 73 * 3600e3).toISOString().slice(0, 19));
  res = w.collectWarnings({ types: ['stale_pending'], now });
  assert.strictEqual(res.warnings.find(x => x.allocation_id === a.id).level, '高');

  // 10 小时前不预警
  setAllocCreated(a.id, new Date(now.getTime() - 10 * 3600e3).toISOString().slice(0, 19));
  res = w.collectWarnings({ types: ['stale_pending'], now });
  assert.ok(!res.warnings.find(x => x.allocation_id === a.id));

  // 已确认后不再待确认超时
  setAllocCreated(a.id, new Date(now.getTime() - 100 * 3600e3).toISOString().slice(0, 19));
  inv.confirmAllocationTxn(a.id);
  res = w.collectWarnings({ types: ['stale_pending'], now });
  assert.ok(!res.warnings.find(x => x.allocation_id === a.id));
});

test('停售资源仍有有效占用：待确认与已确认均高风险', () => {
  reset();
  const tid = makeProductTour();
  const sup = makeSupplier();
  const r1 = makeResource({ sup, name: 'CA-S1' });
  const r2 = makeResource({ sup, name: 'CA-S2' });
  const a1 = inv.createAllocationTxn({ resource_id: r1, tour_id: tid, qty: 3, create_booking: 0 }).allocation;
  const a2 = inv.createAllocationTxn({ resource_id: r2, tour_id: tid, qty: 4, create_booking: 0 }).allocation;
  inv.confirmAllocationTxn(a2.id);
  db.prepare("UPDATE resources SET status='停售' WHERE id IN (?,?)").run(r1, r2);

  const res = w.collectWarnings({ types: ['stopped_active'] });
  assert.strictEqual(res.warnings.length, 2);
  assert.ok(res.warnings.every(x => x.level === '高'));

  // 释放后预警消失
  inv.releaseAllocationTxn(a1.id);
  const res2 = w.collectWarnings({ types: ['stopped_active'] });
  assert.strictEqual(res2.warnings.length, 1);
  assert.strictEqual(res2.warnings[0].allocation_id, a2.id);
});

test('成本快照偏离：确认后供应商涨价/降价超过阈值分中高两档', () => {
  reset();
  const tid = makeProductTour();
  const sup = makeSupplier();
  const r = makeResource({ sup, qty: 100, price: 1000 });
  const a = inv.createAllocationTxn({ resource_id: r, tour_id: tid, qty: 10, create_booking: 0 }).allocation;
  inv.confirmAllocationTxn(a.id); // 快照 1000

  // 涨 5%：不预警
  db.prepare('UPDATE resources SET unit_price=1050 WHERE id=?').run(r);
  assert.strictEqual(w.collectWarnings({ types: ['price_drift'] }).warnings.length, 0);

  // 涨 15%：中风险，影响金额 = 150 × 10 = 1500
  db.prepare('UPDATE resources SET unit_price=1150 WHERE id=?').run(r);
  let res = w.collectWarnings({ types: ['price_drift'] });
  let drift = res.warnings.find(x => x.allocation_id === a.id);
  assert.ok(drift);
  assert.strictEqual(drift.level, '中');
  assert.strictEqual(drift.metrics.direction, 'up');
  assert.strictEqual(drift.metrics.cost_impact, 1500);

  // 降 30%：高风险（锁贵）
  db.prepare('UPDATE resources SET unit_price=700 WHERE id=?').run(r);
  res = w.collectWarnings({ types: ['price_drift'] });
  drift = res.warnings.find(x => x.allocation_id === a.id);
  assert.strictEqual(drift.level, '高');
  assert.strictEqual(drift.metrics.direction, 'down');
  assert.strictEqual(drift.metrics.cost_impact, -3000);
});

test('成本快照偏离：酒店按间夜单价对比并乘晚数估算影响', () => {
  reset();
  const tid = makeProductTour({ depart: d(4), ret: d(8) });
  const sup = makeSupplier('酒店供应商', '酒店');
  const hotel = makeResource({ sup, type: '酒店', name: '偏离酒店', service: d(1), end: d(8), qty: 20, price: 500 });
  const a = inv.createAllocationTxn({ resource_id: hotel, tour_id: tid, qty: 8, start_date: d(4), end_date: d(7), create_booking: 0 }).allocation;
  inv.confirmAllocationTxn(a.id); // 3 晚 × 8 × 500
  db.prepare('UPDATE resources SET unit_price=400 WHERE id=?').run(hotel); // 降 20%
  const res = w.collectWarnings({ types: ['price_drift'] });
  const drift = res.warnings.find(x => x.allocation_id === a.id);
  assert.ok(drift);
  assert.strictEqual(drift.level, '中');
  assert.strictEqual(drift.metrics.cost_impact, -2400); // -100 × 8 × 3
});

test('临行未确认：3 天后出发缺回程/酒店待确认/无地接均逐条预警，等级随天数变化', () => {
  reset();
  const tid = makeProductTour({ code: 'WT-NEAR', depart: d(3) });
  db.prepare(`INSERT INTO flight_bookings (tour_id, direction, flight_no, flight_date, seats, unit_price, confirmed)
    VALUES (?, '去程', 'CA1', ?, 20, 800, 1)`).run(tid, d(3));
  // 无回程、无酒店、无地接
  let res = w.collectWarnings({ types: ['tour_unconfirmed'] });
  let tourWarns = res.warnings.filter(x => x.tour_id === tid);
  const types = tourWarns.map(x => x.resource_type).sort();
  assert.deepStrictEqual(types, ['地接', '航班', '酒店']);
  assert.ok(tourWarns.every(x => x.level === '中'), '3 天后出发为中风险');
  assert.ok(tourWarns.find(x => x.resource_type === '航班').detail.includes('缺回程航班'));

  // 补齐回程（待确认）→ 航班预警仍在，明细变为待确认
  db.prepare(`INSERT INTO flight_bookings (tour_id, direction, flight_no, flight_date, seats, unit_price, confirmed)
    VALUES (?, '回程', 'CA2', ?, 20, 820, 0)`).run(tid, d(6));
  res = w.collectWarnings({ types: ['tour_unconfirmed'] });
  const fw = res.warnings.find(x => x.tour_id === tid && x.resource_type === '航班');
  assert.ok(fw.detail.includes('CA2（回程）待确认'));

  // 确认回程；酒店加一条已确认、地接加一条已确认 → 全部消失
  db.prepare("UPDATE flight_bookings SET confirmed=1 WHERE tour_id=? AND flight_no='CA2'").run(tid);
  db.prepare(`INSERT INTO hotel_bookings (tour_id, hotel_name, room_type, rooms, check_in, check_out, night_price, confirmed)
    VALUES (?, '酒店', '标间', 10, ?, ?, 500, 1)`).run(tid, d(3), d(6));
  db.prepare(`INSERT INTO local_services (tour_id, agency_name, total_price, confirmed)
    VALUES (?, '地接社', 8000, 1)`).run(tid);
  res = w.collectWarnings({ types: ['tour_unconfirmed'] });
  assert.strictEqual(res.warnings.filter(x => x.tour_id === tid).length, 0);
});

test('临行未确认：今天/明天出发为高风险，8 天后出发不预警，已结束团队不预警', () => {
  reset();
  const tNear = makeProductTour({ code: 'WT-D0', depart: d(0) });
  const tFar = makeProductTour({ code: 'WT-D8', depart: d(8) });
  const tDone = makeProductTour({ code: 'WT-DONE', depart: d(1), status: '已结束' });
  const res = w.collectWarnings({ types: ['tour_unconfirmed'] });
  assert.ok(res.warnings.some(x => x.tour_id === tNear && x.level === '高'));
  assert.ok(!res.warnings.some(x => x.tour_id === tFar), '8 天后出发不在 7 天窗口内');
  assert.ok(!res.warnings.some(x => x.tour_id === tDone), '已结束团队不预警');
});

test('汇总与筛选：按等级/资源类型/供应商/日期过滤，排序高风险在前', () => {
  reset();
  const supA = makeSupplier('供应商A', '航班');
  const supB = makeSupplier('供应商B', '酒店');
  const t1 = makeProductTour({ code: 'WT-F1', depart: d(2) });
  const flight = makeResource({ sup: supA, type: '航班', name: 'CA-FLT', service: d(2), qty: 10 });
  inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 10, create_booking: 0 }); // 售罄高风险
  const hotel = makeResource({ sup: supB, type: '酒店', name: 'HTL', service: d(20), end: d(22), qty: 20, price: 400 });
  inv.createAllocationTxn({ resource_id: hotel, tour_id: t1, qty: 17, start_date: d(20), end_date: d(22), create_booking: 0 }); // 中风险

  const all = w.collectWarnings();
  assert.ok(all.summary['高'] >= 1);
  assert.ok(all.by_type.low_stock >= 2);
  assert.ok(all.total >= 2);
  assert.strictEqual(all.warnings[0].level, '高', '高风险排最前');

  const onlyFlight = w.collectWarnings({ filter: { resource_type: '航班' } });
  assert.ok(onlyFlight.warnings.every(x => x.resource_type === '航班'));

  const onlySupB = w.collectWarnings({ filter: { supplier_id: supB } });
  assert.ok(onlySupB.warnings.length >= 1);
  assert.ok(onlySupB.warnings.every(x => String(x.supplier_id) === String(supB)));

  const dated = w.collectWarnings({ filter: { date_from: d(10), date_to: d(30) } });
  assert.ok(dated.warnings.every(x => x.service_date >= d(10) && x.service_date <= d(30)));

  const high = w.collectWarnings({ filter: { level: '高' } });
  assert.ok(high.warnings.every(x => x.level === '高'));
  // summary 不受等级筛选影响
  assert.strictEqual(high.summary['高'], all.summary['高']);
});

test('自定义阈值：horizonDays/staleHours/driftRatio/tourDueDays 生效', () => {
  reset();
  const tid = makeProductTour({ depart: d(15) });
  const sup = makeSupplier();
  const flight = makeResource({ sup, service: d(15), qty: 10 });
  inv.createAllocationTxn({ resource_id: flight, tour_id: tid, qty: 10, create_booking: 0 });
  // 默认 60 天窗口能看到；窗口缩到 10 天则看不到
  assert.ok(w.collectWarnings({ types: ['low_stock'] }).warnings.length >= 1);
  assert.strictEqual(w.collectWarnings({ types: ['low_stock'], config: { horizonDays: 10 } }).warnings.length, 0);

  // 待确认阈值放宽到 100 小时
  const now = new Date();
  const a = db.prepare("SELECT id FROM resource_allocations WHERE resource_id=?").get(flight).id;
  setAllocCreated(a, new Date(now.getTime() - 30 * 3600e3).toISOString().slice(0, 19));
  assert.ok(w.collectWarnings({ types: ['stale_pending'], now }).warnings.length >= 1);
  assert.strictEqual(w.collectWarnings({ types: ['stale_pending'], now, config: { staleHours: 100 } }).warnings.length, 0);
});

test('预警只读：运行分析不改变余量、占用状态与成本快照', () => {
  reset();
  const tid = makeProductTour();
  const sup = makeSupplier();
  const r = makeResource({ sup, qty: 50, price: 800 });
  const a = inv.createAllocationTxn({ resource_id: r, tour_id: tid, qty: 40, create_booking: 1 }).allocation;
  inv.confirmAllocationTxn(a.id);
  db.prepare('UPDATE resources SET unit_price=500, status=? WHERE id=?').run('停售', r);

  w.collectWarnings();
  w.collectWarnings({ config: { horizonDays: 5, staleHours: 1, driftRatio: 0.01 } });

  const row = db.prepare('SELECT status, price_snapshot, cost_snapshot FROM resource_allocations WHERE id=?').get(a.id);
  assert.strictEqual(row.status, '已确认');
  assert.strictEqual(row.price_snapshot, 800);
  assert.strictEqual(row.cost_snapshot, 32000);
  assert.strictEqual(inv.getAvailability(r).available, 10);
});
