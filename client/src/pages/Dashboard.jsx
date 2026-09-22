import { useEffect, useState } from 'react';
import { api, yuan } from '../api.js';
import { StatusBadge } from '../components/ui.jsx';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [tours, setTours] = useState([]);

  useEffect(() => {
    api.get('/stats').then(setStats).catch(() => {});
    api.get('/tours').then(setTours).catch(() => {});
  }, []);

  const open = tours.filter(t => t.status === '收客中');

  return (
    <div>
      <div className="page-head">
        <div><h1>工作台</h1><p>旅行社组团销售与计调作业总览</p></div>
        <div className="head-actions">
          <a className="btn" href="#/products/new">＋ 新建产品</a>
          <a className="btn btn-primary" href="#/tours/new">＋ 创建团队</a>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card stat-teal">
          <div className="stat-icon">🗺️</div>
          <div><div className="stat-num">{stats?.products ?? '—'}</div><div className="stat-label">在售产品</div></div>
        </div>
        <div className="stat-card stat-blue">
          <div className="stat-icon">🧳</div>
          <div><div className="stat-num">{stats?.tours ?? '—'}</div><div className="stat-label">团队总数（收客中 {stats?.openTours ?? 0}）</div></div>
        </div>
        <div className="stat-card stat-green">
          <div className="stat-icon">👥</div>
          <div><div className="stat-num">{stats?.tourists ?? '—'}</div><div className="stat-label">在团游客</div></div>
        </div>
        <div className="stat-card stat-orange">
          <div className="stat-icon">💰</div>
          <div>
            <div className="stat-num">{stats ? yuan(stats.finance.grossProfit) : '—'}</div>
            <div className="stat-label">全部团队预估毛利</div>
          </div>
        </div>
      </div>

      <div className="finance-strip">
        <div><span>总收入</span><strong className="text-green">{stats ? yuan(stats.finance.revenue) : '—'}</strong></div>
        <div className="strip-sep">−</div>
        <div><span>计调成本（切位/控房/地接/其他）</span><strong className="text-red">{stats ? yuan(stats.finance.cost) : '—'}</strong></div>
        <div className="strip-sep">=</div>
        <div><span>预估毛利</span><strong>{stats ? yuan(stats.finance.grossProfit) : '—'}</strong></div>
      </div>

      {stats && (stats.warnings['高'] + stats.warnings['中'] + stats.warnings['低'] > 0) && (
        <a href="#/warnings" className={`warn-banner ${stats.warnings['高'] > 0 ? 'is-high' : ''}`}>
          <span className="warn-banner-icon">🚨</span>
          <div className="warn-banner-text">
            <strong>采购资源预警</strong>
            <span>
              {stats.warnings['高'] > 0 && <em className="text-red">高风险 {stats.warnings['高']} 条</em>}
              {stats.warnings['高'] > 0 && (stats.warnings['中'] > 0 || stats.warnings['低'] > 0) && ' · '}
              {stats.warnings['中'] > 0 && <em className="text-orange">中风险 {stats.warnings['中']} 条</em>}
              {stats.warnings['中'] > 0 && stats.warnings['低'] > 0 && ' · '}
              {stats.warnings['低'] > 0 && <em>低风险 {stats.warnings['低']} 条</em>}
              ，点击进入预警中心处理
            </span>
          </div>
          <span className="warn-banner-go">查看 →</span>
        </a>
      )}
      {stats && (stats.warnings['高'] + stats.warnings['中'] + stats.warnings['低'] === 0) && (
        <a href="#/warnings" className="warn-banner is-ok">
          <span className="warn-banner-icon">✅</span>
          <div className="warn-banner-text">
            <strong>采购资源预警中心</strong>
            <span>未来 60 天暂无库存与供应商风险，点击查看详情</span>
          </div>
          <span className="warn-banner-go">查看 →</span>
        </a>
      )}

      <h2 className="section-title">收客中的团队</h2>
      <div className="card">
        {open.length === 0 ? <div className="empty">📭 暂没收客中的团队，点击右上角「创建团队」开始</div> : (
          <table className="table">
            <thead><tr><th>团号</th><th>线路</th><th>出发日期</th><th>收客进度</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {open.map(t => {
                const pct = Math.min(100, Math.round(t.headcount / t.capacity * 100));
                return (
                  <tr key={t.id}>
                    <td className="mono">{t.code}</td>
                    <td>{t.product_name}</td>
                    <td>{t.departure_date}</td>
                    <td style={{ minWidth: 200 }}>
                      <div className="progress"><div className="progress-bar" style={{ width: pct + '%' }} /></div>
                      <small>{t.headcount}/{t.capacity} 人{pct >= 100 ? '（已满团，自动停收）' : `（余 ${t.capacity - t.headcount} 席）`}</small>
                    </td>
                    <td><StatusBadge status={t.status} full={t.full} /></td>
                    <td><a className="btn btn-sm" href={`#/tours/${t.id}`}>进入团队</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
