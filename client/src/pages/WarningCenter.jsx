import { useEffect, useMemo, useState } from 'react';
import { api, yuan } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import { PageHead, Empty } from '../components/ui.jsx';

const TYPE_ICON = { 航班: '✈️', 酒店: '🏨', 地接: '🚌' };
const LEVEL_STYLE = {
  高: { cls: 'red', icon: '🔴' },
  中: { cls: 'orange', icon: '🟠' },
  低: { cls: 'blue', icon: '🔵' }
};
const TYPES = [
  { key: 'low_stock', label: '低余量', icon: '📉' },
  { key: 'stale_pending', label: '待确认超时', icon: '⏳' },
  { key: 'stopped_active', label: '停售仍占用', icon: '🚫' },
  { key: 'price_drift', label: '成本价偏离', icon: '💹' },
  { key: 'tour_unconfirmed', label: '临行未确认', icon: '🧳' }
];
const RES_TYPES = ['航班', '酒店', '地接'];

export default function WarningCenter() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [level, setLevel] = useState('');
  const [wtype, setWtype] = useState('');
  const [resType, setResType] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [horizon, setHorizon] = useState(60);

  const load = () => {
    const qs = new URLSearchParams();
    if (level) qs.set('level', level);
    if (wtype) qs.set('types', wtype);
    if (resType) qs.set('resource_type', resType);
    if (supplierId) qs.set('supplier_id', supplierId);
    if (dateFrom) qs.set('date_from', dateFrom);
    if (dateTo) qs.set('date_to', dateTo);
    if (horizon) qs.set('horizonDays', horizon);
    api.get('/warnings?' + qs.toString()).then(setData).catch(e => toast(e.message, 'error'));
  };
  useEffect(load, [level, wtype, resType, supplierId, dateFrom, dateTo, horizon]);
  useEffect(() => { api.get('/suppliers').then(setSuppliers).catch(() => {}); }, []);

  const reset = () => {
    setLevel(''); setWtype(''); setResType(''); setSupplierId('');
    setDateFrom(''); setDateTo(''); setHorizon(60);
  };

  const s = data?.summary || { 高: 0, 中: 0, 低: 0 };
  const byType = data?.by_type || {};

  return (
    <div>
      <PageHead title="采购资源预警中心" subtitle={`计调风险雷达：未来 ${horizon} 天库存余量、占用时效、停售风险、成本快照偏离与临行确认情况（只读分析，不改动库存）`}>
        <select className="input" value={horizon} onChange={e => setHorizon(e.target.value)} style={{ maxWidth: 150 }}>
          <option value={7}>未来 7 天</option>
          <option value={30}>未来 30 天</option>
          <option value={60}>未来 60 天</option>
          <option value={90}>未来 90 天</option>
        </select>
        <button className="btn" onClick={load}>🔄 刷新</button>
      </PageHead>

      {/* 风险等级卡片（同时作为等级筛选） */}
      <div className="stat-grid">
        {[
          { lv: '高', icon: '🔴', label: '高风险 · 需立即处理', card: 'stat-orange' },
          { lv: '中', icon: '🟠', label: '中风险 · 尽快跟进', card: 'stat-teal' },
          { lv: '低', icon: '🔵', label: '低风险 · 关注即可', card: 'stat-blue' }
        ].map(c => (
          <button key={c.lv} className={`stat-card warn-stat ${c.card} ${level === c.lv ? 'is-active' : ''}`}
            onClick={() => setLevel(level === c.lv ? '' : c.lv)}>
            <div className="stat-icon">{c.icon}</div>
            <div><div className="stat-num">{s[c.lv]}</div><div className="stat-label">{c.label}</div></div>
          </button>
        ))}
        <div className="stat-card stat-green">
          <div className="stat-icon">📋</div>
          <div><div className="stat-num">{data?.total ?? '—'}</div><div className="stat-label">预警总数（{data?.today || ''} 快照）</div></div>
        </div>
      </div>

      {/* 预警类型快筛 */}
      <div className="warn-type-strip">
        {TYPES.map(t => (
          <button key={t.key}
            className={`warn-type-chip ${wtype === t.key ? 'on' : ''} ${byType[t.key] ? 'has' : ''}`}
            onClick={() => setWtype(wtype === t.key ? '' : t.key)}>
            <span>{t.icon} {t.label}</span>
            <strong>{byType[t.key] || 0}</strong>
          </button>
        ))}
      </div>

      <div className="toolbar warn-toolbar">
        <select className="input" value={resType} onChange={e => setResType(e.target.value)}>
          <option value="">全部资源类型</option>
          {RES_TYPES.map(t => <option key={t}>{TYPE_ICON[t]} {t}</option>)}
        </select>
        <select className="input" value={supplierId} onChange={e => setSupplierId(e.target.value)}>
          <option value="">全部供应商</option>
          {suppliers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <label className="warn-date">出发/服务日期
          <input type="date" className="input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span>~</span>
          <input type="date" className="input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </label>
        <button className="btn" onClick={reset}>清空筛选</button>
      </div>

      <div className="card">
        {!data ? <div className="loading">加载中…</div>
          : data.warnings.length === 0 ? <Empty text="当前筛选条件下没有预警，风控状态良好 🎉" /> : (
          <table className="table warn-table">
            <thead>
              <tr><th>风险</th><th>类型</th><th>资源/团队</th><th>日期</th><th>供应商</th><th>明细</th><th>操作</th></tr>
            </thead>
            <tbody>
              {data.warnings.map(w => <WarningRow key={w.id} w={w} />)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function WarningRow({ w }) {
  const lv = LEVEL_STYLE[w.level];
  const resourceLink = w.resource_id
    ? `#/resources?resource=${w.resource_id}`
    : null;
  return (
    <tr>
      <td><span className={`badge badge-${lv.cls} warn-level`}>{lv.icon} {w.level}</span></td>
      <td><span className="tag warn-kind warn-kind-${w.warning_type}">{w.type_label}</span></td>
      <td style={{ minWidth: 200 }}>
        {w.resource_id ? (
          <>
            <a href={resourceLink}><strong>{TYPE_ICON[w.resource_type]} {w.resource_name}</strong></a>
            <br /><small className="mono">资源 #{w.resource_id}{w.allocation_id ? ` · 占用 #${w.allocation_id}` : ''}</small>
          </>
        ) : (
          <>
            <a href={`#/tours/${w.tour_id}`}><strong>{TYPE_ICON[w.resource_type]} {w.title.split(' ')[0]}</strong></a>
            <br /><small>{w.detail.split('：')[0]}</small>
          </>
        )}
        {w.tour_id && w.resource_id && (
          <><br /><small>团队：<a href={`#/tours/${w.tour_id}`} className="mono">{w.tour_code}</a></small></>
        )}
      </td>
      <td className="nowrap small mono">{w.service_date}{w.end_date ? ` ~ ${w.end_date}` : ''}</td>
      <td className="small">{w.supplier_name || '—'}</td>
      <td className="warn-detail">
        {w.warning_type === 'low_stock' && (
          <span>
            {w.detail}
            <span className="warn-metrics">余量 {w.metrics.available}/{w.metrics.qty}
              {w.metrics.pending > 0 ? ` · 待确认 ${w.metrics.pending}` : ''}
              {w.metrics.confirmed > 0 ? ` · 已确认 ${w.metrics.confirmed}` : ''}</span>
          </span>
        )}
        {w.warning_type === 'price_drift' && (
          <span>
            {w.detail}
            <span className={`warn-metrics ${w.metrics.direction === 'up' ? 'text-red' : 'text-orange'}`}>
              快照 {yuan(w.metrics.price_snapshot)} → 现价 {yuan(w.metrics.current_price)}
              （{w.metrics.direction === 'up' ? '+' : ''}{(w.metrics.drift_ratio * 100).toFixed(1)}%）
            </span>
          </span>
        )}
        {['stale_pending', 'stopped_active', 'tour_unconfirmed'].includes(w.warning_type) && w.detail}
      </td>
      <td className="nowrap">
        {w.resource_id && <a className="btn btn-xs" href={resourceLink}>资源详情</a>}
        {w.tour_id && <a className="btn btn-xs btn-primary" href={`#/tours/${w.tour_id}`}>团队详情</a>}
      </td>
    </tr>
  );
}
