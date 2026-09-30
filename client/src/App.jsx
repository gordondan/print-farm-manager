import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link, Navigate, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Fleet from './pages/Fleet';
import Printers from './pages/Printers';
import PrinterDetail from './pages/PrinterDetail';
import Projects from './pages/Projects';
import Jobs from './pages/Jobs';
import Settings from './pages/Settings';
import Decommissioned from './pages/Decommissioned';

const NAV_ITEMS = [
  { to: '/',               label: 'Dashboard' },
  { to: '/fleet',          label: 'Fleet',         end: true },
  // Anchor into the Fleet page (the queue renders below the fleet): indented under it.
  { to: '/fleet#print-queue', label: 'Print Queue', child: true, hash: '#print-queue' },
  { to: '/printers',       label: 'Printers',      end: true },
  { to: '/projects',       label: 'Projects' },
  { to: '/jobs',           label: 'Jobs' },
  { to: '/decommissioned', label: 'Decommissioned' },
  { to: '/settings',       label: 'Settings' },
];

const navLinkStyle = ({ isActive }) => ({
  display: 'block',
  padding: '8px 14px',
  borderRadius: 6,
  color: isActive ? '#fff' : '#94a3b8',
  background: isActive ? '#1e40af' : 'transparent',
  textDecoration: 'none',
  fontWeight: isActive ? 700 : 400,
  fontSize: 14,
  transition: 'background 0.15s',
  whiteSpace: 'nowrap',
});

// One nav entry. Plain entries are NavLinks. A hash entry is an in-page anchor: NavLink
// ignores the hash when deciding what is active, which would light up both Fleet and its
// anchor, so the active state is computed here from pathname plus hash instead.
function NavItem({ item, styleFn }) {
  const { pathname, hash } = useLocation();
  if (!item.hash) {
    return (
      <NavLink
        to={item.to}
        end={item.to === '/' || !!item.end}
        // Fleet yields the highlight to its Print Queue anchor while that anchor is open.
        style={({ isActive }) => styleFn({ isActive: isActive && !(item.to === '/fleet' && hash === '#print-queue') })}
      >
        {item.label}
      </NavLink>
    );
  }
  const isActive = pathname === '/fleet' && hash === item.hash;
  return <Link to={item.to} style={styleFn({ isActive })}>{item.label}</Link>;
}

export default function App() {
  // Operator-configurable farm name (Settings → Farm Name)
  const [farmName, setFarmName] = useState('Print Farm');
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { if (data.farm_name) setFarmName(data.farm_name); })
      .catch(() => {});

    // Settings page dispatches this on save so the sidebar/topbar update live,
    // without needing a full page refresh.
    const onFarmNameChanged = (e) => setFarmName(e.detail);
    window.addEventListener('farmNameChanged', onFarmNameChanged);
    return () => window.removeEventListener('farmNameChanged', onFarmNameChanged);
  }, []);

  return (
    <BrowserRouter>
      {/* Responsive layout: sidebar on desktop, top nav bar on mobile */}
      <style>{`
        #layout { display: flex; min-height: 100vh; }
        #sidebar { width: 180px; flex-shrink: 0; background: #131720; border-right: 1px solid #1e2433; display: flex; flex-direction: column; padding: 16px 8px; gap: 4px; }
        #topbar { display: none; background: #131720; border-bottom: 1px solid #1e2433; padding: 8px 12px; align-items: center; gap: 8px; flex-wrap: wrap; }
        #main { flex: 1; padding: 24px 28px; overflow-y: auto; min-width: 0; }
        @media (max-width: 600px) {
          #layout { flex-direction: column; }
          #sidebar { display: none; }
          #topbar { display: flex; }
          #main { padding: 16px 14px; }
        }
      `}</style>

      <div id="layout">
        {/* Sidebar (desktop) */}
        <nav id="sidebar">
          <div style={{ padding: '0 6px 16px', borderBottom: '1px solid #1e2433', marginBottom: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#e2e8f0', lineHeight: 1.3 }}>{farmName}</div>
            <div style={{ fontWeight: 400, fontSize: 11, color: '#475569' }}>Print Farm Manager</div>
          </div>
          {NAV_ITEMS.map((item) => (
            <NavItem
              key={item.to}
              item={item}
              styleFn={(state) => ({
                ...navLinkStyle(state),
                ...(item.child && { marginLeft: 12, padding: '6px 12px', fontSize: 13 }),
              })}
            />
          ))}
        </nav>

        {/* Top nav bar (mobile) */}
        <nav id="topbar">
          <span style={{ fontWeight: 800, fontSize: 14, color: '#e2e8f0', marginRight: 8 }}>{farmName}</span>
          {NAV_ITEMS.map((item) => (
            <NavItem
              key={item.to}
              item={item}
              styleFn={({ isActive }) => ({
                padding: '5px 10px',
                borderRadius: 6,
                color: isActive ? '#fff' : '#94a3b8',
                background: isActive ? '#1e40af' : '#1e2433',
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: isActive ? 700 : 400,
              })}
            />
          ))}
        </nav>

        {/* Main content */}
        <main id="main">
          <Routes>
            <Route path="/"                element={<Dashboard />} />
            <Route path="/fleet"           element={<Fleet />} />
            {/* The queue used to be its own page; keep old bookmarks working. */}
            <Route path="/fleet/queue"     element={<Navigate to="/fleet#print-queue" replace />} />
            <Route path="/printers"        element={<Printers />} />
            <Route path="/printers/:id"    element={<PrinterDetail />} />
            <Route path="/projects"        element={<Projects />} />
            <Route path="/jobs"            element={<Jobs />} />
            <Route path="/decommissioned"  element={<Decommissioned />} />
            <Route path="/settings"        element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
