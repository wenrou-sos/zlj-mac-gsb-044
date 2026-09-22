import { useCallback, useEffect, useState } from 'react';
import { api, yuan } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import { PageHead, Empty } from '../components/ui.jsx';

const LEVELS = ['高', '中', '低'];
const LEVEL_BADGE = { 高: 'red', 中: 'orange', 低: 'blue' };
const KIND_LABEL = {
  low_stock: '📉 低余量',
  pending_timeout: '⏰ 待确认超时',
  inactive_with_hold: '🚫 停售仍有占用',
  price_deviation: '💹 快照偏离',
  departure_unconfirmed: '🧳 临出发未确认'
};
const TYPE_ICON = { 航班: '✈️', 酒店: '🏨', 地接: '🚌' };

/* 各预警类型的关键指标展示 */
function Metric({ a }) {
  const m = a.metrics || {};
  switch (a.kind) {
    case 'low_stock':
      return <span className={m.available <= 0 ? 'text-red' : 'text-orange'}>
        余 <strong>{m.available}</strong>/{m.qty}（{m.ratio_pct}%）
      </span>;
    case 'pending_timeout':
      return <span className="text-orange">已挂起 <strong>{m.hours}h</strong> · ×{m.qty}</span>;
    case 'inactive_with_hold':
      return <span className="text-red">{m.alloc_cnt} 笔 / {m.total_qty} 件仍占用</span>;
    case 'price_deviation':
      return <span className={m.deviation_pct > 0 ? 'text-red' : 'text-green'}>
        {m.deviation_pct > 0 ? '+' : ''}{m.deviation_pct}%（{yuan(m.price_snapshot)} → {yuan(m.current_price)}）
      </span>;
    case 'departure_unconfirmed':
      return <span className={m.days_left <= 3 ? 'text-red' : 'text-orange'}>余 <strong>{m.days_left}</strong> 天 · {m.headcount}/{m.capacity} 人</span>;
    default:
      return null;
  }
}

export default function Alerts() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [filters, setFilters] = useState({ level: '', kind: '', type: '', supplier_id: '', from: '', to: '' });
  const set = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
    api.get('/alerts?' + qs.toString()).then(setData).catch(e => toast(e.message, 'error'));
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/suppliers').then(setSuppliers).catch(() => {}); }, []);

  const reset = () => setFilters({ level: '', kind: '', type: '', supplier_id: '', from: '', to: '' });
  const sum = data?.summary;

  return (
    <div>
      <PageHead title="采购资源预警中心"
        subtitle={`扫描库存余量 / 占用时效 / 停售占用 / 成本快照 / 临出发确认完整度${data ? ` · 更新于 ${data.generated_at}` : ''}`}>
        <button className="btn" onClick={load}>↻ 刷新</button>
      </PageHead>

      {/* 汇总卡：点击按等级筛选 */}
      <div className="stat-grid">
        {LEVELS.map(l => (
          <div key={l} className={`stat-card stat-${LEVEL_BADGE[l]} alert-stat ${filters.level === l ? 'is-on' : ''}`}
            onClick={() => set('level', filters.level === l ? '' : l)}>
            <div className="stat-icon">{l === '高' ? '🔴' : l === '中' ? '🟠' : '🔵'}</div>
            <div><div className="stat-num">{sum ? sum.by_level[l] : '—'}</div>
              <div className="stat-label">{l}风险预警</div></div>
          </div>
        ))}
        <div className="stat-card stat-teal alert-stat" onClick={reset}>
          <div className="stat-icon">🚨</div>
          <div><div className="stat-num">{sum ? sum.total : '—'}</div>
            <div className="stat-label">全部预警（点击重置筛选）</div></div>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="card filter-bar">
        <div className="tabs" style={{ marginBottom: 0 }}>
          <button className={`tab ${!filters.type ? 'on' : ''}`} onClick={() => set('type', '')}>全部类型</button>
          {Object.keys(TYPE_ICON).map(t => (
            <button key={t} className={`tab ${filters.type === t ? 'on' : ''}`} onClick={() => set('type', filters.type === t ? '' : t)}>
              {TYPE_ICON[t]} {t}
            </button>
          ))}
        </div>
        <select className="input filter-ctrl" value={filters.kind} onChange={e => set('kind', e.target.value)}>
          <option value="">全部预警类型</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input filter-ctrl" value={filters.supplier_id} onChange={e => set('supplier_id', e.target.value)}>
          <option value="">全部供应商</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{TYPE_ICON[s.type]} {s.name}</option>)}
        </select>
        <label className="filter-date">出发/服务日
          <input type="date" className="input" value={filters.from} onChange={e => set('from', e.target.value)} />
        </label>
        <span className="filter-sep">~</span>
        <input type="date" className="input filter-date-end" value={filters.to} onChange={e => set('to', e.target.value)} />
        <button className="btn btn-sm" onClick={reset}>重置</button>
      </div>

      {/* 预警列表 */}
      {!data ? <div className="loading">扫描中…</div> : data.alerts.length === 0 ? (
        <div className="card"><Empty text={sum.total === 0 ? '🎉 当前无采购风险，库存与供应商状态健康' : '当前筛选条件下无预警，试试重置筛选'} /></div>
      ) : (
        <div className="card" style={{ padding: '8px 12px' }}>
          <table className="table">
            <thead>
              <tr><th>等级</th><th>预警内容</th><th>资源类型</th><th>供应商</th><th>关联团队</th><th>日期</th><th>关键指标</th><th></th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map(a => (
                <tr key={a.id} className={`alert-row alert-lv-${a.level === '高' ? 'high' : a.level === '中' ? 'mid' : 'low'}`}>
                  <td><span className={`badge badge-${LEVEL_BADGE[a.level]}`}>{a.level}风险</span></td>
                  <td style={{ minWidth: 320 }}>
                    <div className="alert-title">
                      <span className="tag">{KIND_LABEL[a.kind] || a.kind_label}</span>
                      <strong>{a.title}</strong>
                    </div>
                    <small>{a.detail}</small>
                    {a.suggestion && <div className="alert-tip">💡 {a.suggestion}</div>}
                  </td>
                  <td className="nowrap">{a.resource_type ? `${TYPE_ICON[a.resource_type]} ${a.resource_type}` : '—'}</td>
                  <td className="small">{a.supplier_name || '—'}</td>
                  <td>{a.tour_id
                    ? <a className="mono" href={`#/tours/${a.tour_id}`}>{a.tour_code}</a>
                    : '—'}</td>
                  <td className="mono small nowrap">{a.date}</td>
                  <td className="nowrap"><Metric a={a} /></td>
                  <td className="nowrap">
                    {a.resource_id && <a className="btn btn-xs" href={`#/resources/${a.resource_id}`}>资源</a>}
                    {a.tour_id && <a className="btn btn-xs" href={`#/tours/${a.tour_id}`}>团队</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card note-card">
        📌 监控规则：未来 {data?.params.days ?? 60} 天余量 ≤{data?.params.low_stock_pct ?? 20}% 报警；待确认超 {data?.params.pending_hours ?? 24} 小时报警；
        快照与采购价偏离 ≥{data?.params.deviation_pct ?? 10}% 报警；距出发 {data?.params.depart_within ?? 7} 天内检查航班/酒店/地接确认完整度（≤{data?.params.depart_urgent ?? 3} 天升为高风险）。
        预警为只读扫描，不影响库存与财务数据。
      </div>
    </div>
  );
}
