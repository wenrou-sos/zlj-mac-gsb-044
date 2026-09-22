// 采购资源预警中心测试
// 运行：npm test（使用独立临时数据库 tmp-test-alerts，不影响 data/travel.db 与其他测试）
process.env.TRAVEL_DB_FILE = require('path').join(__dirname, '..', 'tmp-test-alerts', 'test.db');

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const testDir = path.join(__dirname, '..', 'tmp-test-alerts');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const db = require('./db');
const inv = require('./inventory');
const alerts = require('./alerts');

/* ---------- 工具 ---------- */
const localDate = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDate(d); };
const hoursAgo = (h) => {
  const d = new Date(Date.now() - h * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/* ---------- 固定基础数据 ---------- */
function setup() {
  db.exec(`DELETE FROM resource_allocations; DELETE FROM resources; DELETE FROM suppliers;
    DELETE FROM notices; DELETE FROM other_costs; DELETE FROM local_services;
    DELETE FROM hotel_bookings; DELETE FROM flight_bookings; DELETE FROM tourists;
    DELETE FROM tours; DELETE FROM itinerary_days; DELETE FROM products;
    DELETE FROM sqlite_sequence;`);
  db.prepare(`INSERT INTO products (name, days, departure_city, destination, price_double)
    VALUES ('预警测试线路', 3, '上海', '三亚', 3000)`).run();
  const pid = db.prepare('SELECT id FROM products').get().id;
  const insTour = db.prepare(`INSERT INTO tours (code, product_id, departure_date, return_date, capacity, status)
    VALUES (?,?,?,?,?, '收客中')`);
  // 三个团：2 天后出发（紧急）、5 天后出发（临近）、30 天后出发（不在临出发窗口）
  const tUrgent = insTour.run('AL-URGENT', pid, plus(2), plus(4), 20).lastInsertRowid;
  const tSoon = insTour.run('AL-SOON', pid, plus(5), plus(7), 20).lastInsertRowid;
  const tFar = insTour.run('AL-FAR', pid, plus(30), plus(32), 20).lastInsertRowid;

  const supF = db.prepare("INSERT INTO suppliers (name, type) VALUES ('测试航司', '航班')").run().lastInsertRowid;
  const supH = db.prepare("INSERT INTO suppliers (name, type) VALUES ('测试酒店集团', '酒店')").run().lastInsertRowid;
  const supL = db.prepare("INSERT INTO suppliers (name, type) VALUES ('测试地接社', '地接')").run().lastInsertRowid;

  const insRes = db.prepare(`INSERT INTO resources (supplier_id, type, name, service_date, end_date, qty, unit_price, status)
    VALUES (?,?,?,?,?,?,?,?)`);
  // 10 天后航班 10 座；70 天后航班（超出 60 天扫描窗口）；5~9 天酒店每日 4 间；10 天后地接 2 团
  const flight = insRes.run(supF, '航班', 'CA9001', plus(10), null, 10, 500, '在售').lastInsertRowid;
  const flightFar = insRes.run(supF, '航班', 'CA9002', plus(70), null, 10, 500, '在售').lastInsertRowid;
  const hotel = insRes.run(supH, '酒店', '预警测试酒店', plus(5), plus(9), 4, 300, '在售').lastInsertRowid;
  const local = insRes.run(supL, '地接', '预警测试地接', plus(10), null, 2, 5000, '在售').lastInsertRowid;

  return { tUrgent, tSoon, tFar, supF, supH, supL, flight, flightFar, hotel, local };
}

const kindsOf = (result) => result.alerts.map(a => a.kind);
const findByKind = (result, kind) => result.alerts.filter(a => a.kind === kind);

/* ================= 1. 低余量资源 ================= */
test('低余量：余量≤20%为中风险，售罄为高风险，且只扫描未来60天窗口', () => {
  const { tFar, flight, flightFar } = setup();
  // 窗口内航班占 9/10（余 1，10%）→ 中风险
  inv.createAllocationTxn({ resource_id: flight, tour_id: tFar, qty: 9, create_booking: 0 });
  // 窗口外（70 天后）航班占满 → 不应产生低余量预警
  inv.createAllocationTxn({ resource_id: flightFar, tour_id: tFar, qty: 10, create_booking: 0 });

  let r = alerts.computeAlerts();
  let low = findByKind(r, 'low_stock');
  assert.strictEqual(low.length, 1);
  assert.strictEqual(low[0].level, '中');
  assert.strictEqual(low[0].resource_id, flight);
  assert.strictEqual(low[0].metrics.available, 1);
  assert.strictEqual(low[0].metrics.qty, 10);

  // 再占 1 座 → 售罄 → 高风险
  inv.createAllocationTxn({ resource_id: flight, tour_id: tFar, qty: 1, create_booking: 0 });
  r = alerts.computeAlerts();
  low = findByKind(r, 'low_stock');
  assert.strictEqual(low.length, 1);
  assert.strictEqual(low[0].level, '高');
  assert.strictEqual(low[0].metrics.available, 0);
});

test('低余量：酒店按逐日最差一天判定；停售资源不报低余量', () => {
  const { tFar, hotel } = setup();
  // 占 plus(5)~plus(6) 一晚 3 间 → 该日余 1/4（25%）不报警；占 4 间 → 当日售罄
  inv.createAllocationTxn({ resource_id: hotel, tour_id: tFar, qty: 3, start_date: plus(5), end_date: plus(6), create_booking: 0 });
  let r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'low_stock').length, 0);

  inv.createAllocationTxn({ resource_id: hotel, tour_id: tFar, qty: 1, start_date: plus(5), end_date: plus(6), create_booking: 0 });
  r = alerts.computeAlerts();
  const low = findByKind(r, 'low_stock');
  assert.strictEqual(low.length, 1);
  assert.strictEqual(low[0].level, '高');
  assert.strictEqual(low[0].date, plus(5), '应指出最差的那一天');

  // 停售后不再报低余量（改由停售占用预警覆盖）
  db.prepare("UPDATE resources SET status='停售' WHERE id=?").run(hotel);
  r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'low_stock').length, 0);
  assert.strictEqual(findByKind(r, 'inactive_with_hold').length, 1);
});

/* ================= 2. 待确认超时 ================= */
test('待确认超时：超过24小时预警，超72小时或临近出发升级为高', () => {
  const { tFar, flight } = setup();
  const a = inv.createAllocationTxn({ resource_id: flight, tour_id: tFar, qty: 2, create_booking: 0 }).allocation;

  // 刚创建（<24h）不报警
  let r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'pending_timeout').length, 0);

  // 回拨 25 小时 → 中风险
  db.prepare('UPDATE resource_allocations SET created_at=? WHERE id=?').run(hoursAgo(25), a.id);
  r = alerts.computeAlerts();
  let pend = findByKind(r, 'pending_timeout');
  assert.strictEqual(pend.length, 1);
  assert.strictEqual(pend[0].level, '中');
  assert.ok(pend[0].metrics.hours >= 24);

  // 回拨 80 小时（≥ 24*3）→ 高风险
  db.prepare('UPDATE resource_allocations SET created_at=? WHERE id=?').run(hoursAgo(80), a.id);
  r = alerts.computeAlerts();
  pend = findByKind(r, 'pending_timeout');
  assert.strictEqual(pend[0].level, '高');

  // 确认后不再报警
  inv.confirmAllocationTxn(a.id);
  r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'pending_timeout').length, 0);
});

test('待确认超时：团队临近出发（≤3天）即使未满72小时也升为高风险', () => {
  const { tUrgent, local } = setup();
  // 地接服务日在 10 天后，但团队 2 天后出发（业务上允许占位其他日期资源的场景此处以航班代替更典型，
  // 这里直接验证：临出发团队的待确认占用被升级）
  const a = inv.createAllocationTxn({ resource_id: local, tour_id: tUrgent, qty: 1, create_booking: 0 }).allocation;
  db.prepare('UPDATE resource_allocations SET created_at=? WHERE id=?').run(hoursAgo(30), a.id);
  const r = alerts.computeAlerts();
  const pend = findByKind(r, 'pending_timeout');
  assert.strictEqual(pend.length, 1);
  assert.strictEqual(pend[0].level, '高');
  assert.strictEqual(pend[0].tour_id, tUrgent);
});

/* ================= 3. 停售仍有占用 ================= */
test('停售仍有有效占用：含已确认为高风险，仅待确认为中风险；释放后消除', () => {
  const { tFar, flight, local } = setup();
  const a1 = inv.createAllocationTxn({ resource_id: flight, tour_id: tFar, qty: 3, create_booking: 0 }).allocation;
  inv.confirmAllocationTxn(a1.id);
  const a2 = inv.createAllocationTxn({ resource_id: local, tour_id: tFar, qty: 1, create_booking: 0 }).allocation;

  db.prepare("UPDATE resources SET status='停售' WHERE id IN (?,?)").run(flight, local);
  let r = alerts.computeAlerts();
  const inact = findByKind(r, 'inactive_with_hold');
  assert.strictEqual(inact.length, 2);
  const flightAlert = inact.find(x => x.resource_id === flight);
  const localAlert = inact.find(x => x.resource_id === local);
  assert.strictEqual(flightAlert.level, '高', '含已确认占用 → 高');
  assert.strictEqual(localAlert.level, '中', '仅待确认 → 中');
  assert.strictEqual(flightAlert.metrics.confirmed_cnt, 1);

  // 释放全部占用后预警消除
  inv.releaseAllocationTxn(a1.id, '测试');
  inv.releaseAllocationTxn(a2.id, '测试');
  r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'inactive_with_hold').length, 0);
});

/* ================= 4. 成本快照偏离 ================= */
test('成本快照偏离：快照与当前采购价偏离≥10%双向预警，<10%不报', () => {
  const { tFar, flight } = setup();
  const a = inv.createAllocationTxn({ resource_id: flight, tour_id: tFar, qty: 2, create_booking: 0 }).allocation;
  inv.confirmAllocationTxn(a.id); // 快照 500

  // +6%（530）→ 未达阈值，不报
  db.prepare('UPDATE resources SET unit_price=530 WHERE id=?').run(flight);
  let r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'price_deviation').length, 0);

  // +12%（560）→ 中风险（上涨）
  db.prepare('UPDATE resources SET unit_price=560 WHERE id=?').run(flight);
  r = alerts.computeAlerts();
  let dev = findByKind(r, 'price_deviation');
  assert.strictEqual(dev.length, 1);
  assert.strictEqual(dev[0].level, '中');
  assert.strictEqual(dev[0].metrics.deviation_pct, 12);
  assert.match(dev[0].title, /上涨/);

  // -40%（300）→ 偏离≥30% 高风险（下跌）
  db.prepare('UPDATE resources SET unit_price=300 WHERE id=?').run(flight);
  r = alerts.computeAlerts();
  dev = findByKind(r, 'price_deviation');
  assert.strictEqual(dev[0].level, '高');
  assert.strictEqual(dev[0].metrics.deviation_pct, -40);
  assert.match(dev[0].title, /下跌/);

  // 待确认占用不产生快照偏离预警
  const b = inv.createAllocationTxn({ resource_id: flight, tour_id: tFar, qty: 1, create_booking: 0 }).allocation;
  r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'price_deviation').filter(x => x.allocation_id === b.id).length, 0);
});

/* ================= 5. 临近出发未确认完整 ================= */
test('临出发：7天内缺航班/酒店/地接逐类预警，≤3天为高、其余为中，确认完整后消除', () => {
  const { tUrgent, tSoon, tFar } = setup();
  let r = alerts.computeAlerts();
  let dep = findByKind(r, 'departure_unconfirmed');

  // tUrgent（2天后）：航班/酒店/地接 3 类全缺 → 3 条高风险
  const urgent = dep.filter(a => a.tour_id === tUrgent);
  assert.strictEqual(urgent.length, 3);
  assert.ok(urgent.every(a => a.level === '高'));
  assert.deepStrictEqual(urgent.map(a => a.resource_type).sort(), ['地接', '航班', '酒店']);
  assert.ok(urgent.every(a => a.metrics.missing === true));

  // tSoon（5天后）→ 中风险；tFar（30天后）→ 不在窗口
  const soon = dep.filter(a => a.tour_id === tSoon);
  assert.strictEqual(soon.length, 3);
  assert.ok(soon.every(a => a.level === '中'));
  assert.strictEqual(dep.filter(a => a.tour_id === tFar).length, 0);

  // 给 tUrgent 补一条已确认航班 → 航班类预警消除，剩 2 条
  db.prepare(`INSERT INTO flight_bookings (tour_id, flight_no, seats, unit_price, confirmed)
    VALUES (?, 'CA9001', 10, 500, 1)`).run(tUrgent);
  // 补一条未确认酒店 → 酒店类变为「未确认」而非「未安排」，仍报警
  db.prepare(`INSERT INTO hotel_bookings (tour_id, hotel_name, rooms, check_in, check_out, night_price, confirmed)
    VALUES (?, '某酒店', 5, ?, ?, 300, 0)`).run(tUrgent, plus(2), plus(4));
  r = alerts.computeAlerts();
  dep = findByKind(r, 'departure_unconfirmed').filter(a => a.tour_id === tUrgent);
  assert.strictEqual(dep.length, 2);
  assert.deepStrictEqual(dep.map(a => a.resource_type).sort(), ['地接', '酒店']);
  const hotelAlert = dep.find(a => a.resource_type === '酒店');
  assert.strictEqual(hotelAlert.metrics.missing, false);
  assert.strictEqual(hotelAlert.metrics.unconfirmed_cnt, 1);

  // 酒店确认后 → 只剩地接
  db.prepare('UPDATE hotel_bookings SET confirmed=1 WHERE tour_id=?').run(tUrgent);
  r = alerts.computeAlerts();
  dep = findByKind(r, 'departure_unconfirmed').filter(a => a.tour_id === tUrgent);
  assert.strictEqual(dep.length, 1);
  assert.strictEqual(dep[0].resource_type, '地接');
});

test('临出发：已出团/已结束的团队不再预警', () => {
  const { tUrgent } = setup();
  db.prepare("UPDATE tours SET status='已出团' WHERE id=?").run(tUrgent);
  const r = alerts.computeAlerts();
  assert.strictEqual(findByKind(r, 'departure_unconfirmed').filter(a => a.tour_id === tUrgent).length, 0);
});

/* ================= 6. 筛选与汇总 ================= */
test('筛选：按风险等级/资源类型/供应商/日期过滤，汇总不受筛选影响', () => {
  const { tUrgent, tFar, supF, flight, hotel } = setup();
  // 制造多类预警：航班售罄（高·航班·supF）+ 酒店紧张（中·酒店·supH）+ 临出发（高·tUrgent）
  inv.createAllocationTxn({ resource_id: flight, tour_id: tFar, qty: 10, create_booking: 0 });
  inv.createAllocationTxn({ resource_id: hotel, tour_id: tFar, qty: 4, start_date: plus(5), end_date: plus(6), create_booking: 0 });

  const all = alerts.computeAlerts();
  assert.ok(all.summary.total >= 5); // 1低余量(高) + 1低余量(高·酒店售罄) + 3临出发
  assert.strictEqual(all.summary.by_level['高'] + all.summary.by_level['中'] + all.summary.by_level['低'], all.summary.total);

  // 按等级
  const high = alerts.computeAlerts({ level: '高' });
  assert.ok(high.alerts.length > 0);
  assert.ok(high.alerts.every(a => a.level === '高'));
  assert.strictEqual(high.summary.total, all.summary.total, '汇总基于全量，不受筛选影响');

  // 按资源类型
  const flightOnly = alerts.computeAlerts({ type: '航班' });
  assert.ok(flightOnly.alerts.length > 0);
  assert.ok(flightOnly.alerts.every(a => a.resource_type === '航班'));

  // 按供应商
  const bySup = alerts.computeAlerts({ supplier_id: supF });
  assert.ok(bySup.alerts.length > 0);
  assert.ok(bySup.alerts.every(a => a.supplier_id === supF));

  // 按日期范围：临出发预警日期为出发日（plus(2)），航班低余量日期为 plus(10)
  const dateFiltered = alerts.computeAlerts({ from: plus(8), to: plus(12) });
  assert.ok(dateFiltered.alerts.length > 0);
  assert.ok(dateFiltered.alerts.every(a => a.date >= plus(8) && a.date <= plus(12)));
  assert.ok(dateFiltered.alerts.some(a => a.kind === 'low_stock'));
  assert.ok(!dateFiltered.alerts.some(a => a.kind === 'departure_unconfirmed'));

  // 排序：高风险在前
  const levels = all.alerts.map(a => a.level);
  const rank = { 高: 0, 中: 1, 低: 2 };
  for (let i = 1; i < levels.length; i++) {
    assert.ok(rank[levels[i]] >= rank[levels[i - 1]], '应按风险等级降序排列');
  }
});

test('规则参数可调：扫描窗口/阈值可通过参数覆盖', () => {
  const { tFar, flightFar } = setup();
  inv.createAllocationTxn({ resource_id: flightFar, tour_id: tFar, qty: 10, create_booking: 0 });
  // 默认 60 天窗口：70 天后的资源不报
  assert.strictEqual(findByKind(alerts.computeAlerts(), 'low_stock').length, 0);
  // 放宽到 90 天：报售罄
  const r = alerts.computeAlerts({ days: 90 });
  const low = findByKind(r, 'low_stock');
  assert.strictEqual(low.length, 1);
  assert.strictEqual(low[0].resource_id, flightFar);
});
