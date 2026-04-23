import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase.js'

// ─── Cylinder presets (East Africa standard LPG) ───────────────────────────
export const CYLINDER_PRESETS = [
  { id: '3kg',  label: '3 kg',  net_g:  3000, tare_g:  5000 },
  { id: '6kg',  label: '6 kg',  net_g:  6000, tare_g:  8000 },
  { id: '12kg', label: '12 kg', net_g: 12000, tare_g: 14000 },
  { id: '15kg', label: '15 kg', net_g: 15000, tare_g: 17000 },
]
const DEFAULT_CYLINDER = '6kg'

// ─── Rolling 7-day window helper ──────────────────────────────────────────
const getRolling7Days = () =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    return {
      label:   d.toLocaleDateString([], { weekday: 'short' }).slice(0, 3),
      dateStr: d.toDateString(),
    }
  })

// ─── weightToPercent ──────────────────────────────────────────────────────
const weightToPercent = (weight_g, preset, customTare_g = null) => {
  if (weight_g == null || !preset) return 0
  const w = parseFloat(weight_g)
  if (isNaN(w)) return 0
  const gasRemaining = customTare_g != null ? w - parseFloat(customTare_g) : w
  const raw     = (gasRemaining / preset.net_g) * 100
  const clamped = Math.min(100, Math.max(0, raw))
  return isNaN(clamped) ? 0 : parseFloat(clamped.toFixed(2))
}

// ─── MQ6 thresholds ────────────────────────────────────────────────────────
const LPG_PPM_LOW  = 200
const LPG_PPM_HIGH = 1000

const deriveSeverity = (ppm) => {
  if (ppm == null || ppm < LPG_PPM_LOW) return 'safe'
  if (ppm >= LPG_PPM_HIGH) return 'high'
  return 'low'
}
const filterPpm = (ppm) => (ppm != null && ppm >= LPG_PPM_LOW ? Number(ppm) : null)

// ─── Safety recommendations ────────────────────────────────────────────────
const getRecommendations = (severity, level, ppm) => {
  if (severity === 'high') return [
    { icon: '🚨', text: 'EVACUATE immediately — do not delay', urgent: true },
    { icon: '⚡', text: 'Cut all electrical power at the mains', urgent: true },
    { icon: '🚫', text: 'Do NOT operate switches or appliances', urgent: true },
    { icon: '📞', text: 'Call emergency services immediately', urgent: false },
    { icon: '🪟', text: 'Open all windows and doors if safe', urgent: false },
    ppm && ppm > 800
      ? { icon: '☣️', text: `Extremely high: ~${Math.round(ppm)} ppm — stay clear`, urgent: true }
      : { icon: '📊', text: `MQ6 reading ~${ppm ? Math.round(ppm) : '—'} ppm`, urgent: false },
  ]
  if (severity === 'low') return [
    { icon: '⚠️', text: 'Ventilate now — open windows', urgent: true },
    { icon: '🔍', text: 'Inspect cylinder valve and connections', urgent: false },
    { icon: '🚭', text: 'No flames or ignition sources nearby', urgent: false },
    { icon: '👁️', text: 'Monitor MQ6 readings closely', urgent: false },
    ppm ? { icon: '📊', text: `Current MQ6: ~${Math.round(ppm)} ppm`, urgent: false }
        : { icon: '📊', text: 'Track PPM trend in Analytics', urgent: false },
  ]
  if (level < 20) return [
    { icon: '📦', text: 'Cylinder critically low — arrange refill', urgent: true },
    { icon: '📋', text: 'Contact your gas supplier today', urgent: false },
    { icon: '🕐', text: 'Less than a week of gas remaining', urgent: false },
  ]
  if (level < 40) return [
    { icon: '📦', text: 'Below 40% — schedule refill this week', urgent: false },
    { icon: '📊', text: 'Track usage in the Analytics tab', urgent: false },
  ]
  return [
    { icon: '✅', text: 'System operating normally', urgent: false },
    { icon: '🔍', text: 'Routine monthly inspection due', urgent: false },
  ]
}

// ─── Color tokens ──────────────────────────────────────────────────────────
const C = {
  safe: { main: '#00e5a0', dim: 'rgba(0,229,160,0.10)',  border: 'rgba(0,229,160,0.22)',  glow: '0 0 28px rgba(0,229,160,0.28)' },
  low:  { main: '#ffb020', dim: 'rgba(255,176,32,0.10)', border: 'rgba(255,176,32,0.22)', glow: '0 0 28px rgba(255,176,32,0.28)' },
  high: { main: '#ff4560', dim: 'rgba(255,69,96,0.10)',  border: 'rgba(255,69,96,0.22)',  glow: '0 0 28px rgba(255,69,96,0.38)' },
}
const levelColor = l => l < 20 ? C.high : l < 40 ? C.low : C.safe
const isConfigured = () => !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)

// ─── localStorage helpers ──────────────────────────────────────────────────
const lsGet = (key, fallback = null) => {
  try {
    const v = localStorage.getItem(key)
    return v != null ? JSON.parse(v) : fallback
  } catch { return fallback }
}
const lsSet = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)) } catch {}
}

// ─── Demo data ─────────────────────────────────────────────────────────────
let demoIdx = 0
const demoSevs = ['safe','safe','safe','safe','low','safe','safe','high','safe','safe','safe','safe']
const demoPpm  = [45, 52, 48, 61, 350, 55, 44, 750, 51, 48, 53, 50]
const genDemoWeight = prev => Math.max(8050, Math.min(14000, (prev ?? 11400) + (Math.random() - 0.52) * 30))

const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = d => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })

// ─── Shared UI primitives ──────────────────────────────────────────────────
function StatusDot({ online }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
      background: online ? '#00e5a0' : '#ff4560',
      boxShadow: online ? '0 0 8px #00e5a0' : '0 0 8px #ff4560',
      animation: online ? 'pulseGreen 2s ease infinite' : 'pulseRed 1.5s ease infinite',
    }} />
  )
}

function Chip({ label, color, bg, border, style }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
      borderRadius: 20, background: bg || 'rgba(255,255,255,0.06)',
      border: `1px solid ${border || 'rgba(255,255,255,0.1)'}`,
      fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500,
      color: color || 'var(--text-2)', letterSpacing: '0.05em', whiteSpace: 'nowrap',
      ...style
    }}>{label}</span>
  )
}

function Card({ children, style, accent, glow }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${accent ? accent + '28' : 'var(--border)'}`,
      borderRadius: 'var(--r)', padding: '18px 16px',
      boxShadow: glow || 'var(--shadow)',
      transition: 'box-shadow 0.3s, border-color 0.3s',
      minWidth: 0,
      ...style
    }}>{children}</div>
  )
}

function SectionTitle({ children, style }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
      color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase',
      marginBottom: 14, ...style
    }}>{children}</div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// SAFETY RECOMMENDATION POPUP
// ══════════════════════════════════════════════════════════════════════════
function SafetyPopup({ severity, ppm, onDismiss }) {
  const isHigh = severity === 'high'
  const isLow  = severity === 'low'
  if (!isHigh && !isLow) return null

  const col    = isHigh ? C.high : C.low
  const rules  = getRecommendations(severity, 100, ppm)
  const title  = isHigh ? '🚨 CRITICAL GAS LEAK DETECTED' : '⚠️ LOW-LEVEL GAS LEAK DETECTED'
  const sub    = isHigh
    ? `Extremely dangerous — immediate action required${ppm ? ` · ~${Math.round(ppm)} ppm` : ''}`
    : `Minor leakage detected${ppm ? ` · ~${Math.round(ppm)} ppm` : ''} — take precautions`

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={isHigh ? undefined : onDismiss}
        style={{
          position: 'fixed', inset: 0, zIndex: 900,
          background: isHigh
            ? 'rgba(255,0,30,0.18)'
            : 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(3px)',
          animation: 'fadeIn 0.25s ease',
        }}
      />

      {/* Modal */}
      <div style={{
        position: 'fixed', left: '50%', top: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 910, width: 'min(92vw, 420px)',
        background: isHigh ? '#0d0608' : 'var(--surface)',
        border: `1.5px solid ${col.main}55`,
        borderRadius: 16,
        boxShadow: `0 0 60px ${col.main}44, 0 24px 60px rgba(0,0,0,0.7)`,
        overflow: 'hidden',
        animation: 'popIn 0.3s cubic-bezier(0.34,1.56,0.64,1)',
      }}>

        {/* Header stripe */}
        <div style={{
          background: isHigh
            ? 'linear-gradient(135deg, rgba(255,69,96,0.22), rgba(255,0,30,0.10))'
            : 'linear-gradient(135deg, rgba(255,176,32,0.18), rgba(255,176,32,0.06))',
          borderBottom: `1px solid ${col.main}33`,
          padding: '20px 20px 16px',
          animation: isHigh ? 'shimmer 1.2s ease infinite' : undefined,
        }}>
          <div style={{
            fontFamily: 'var(--font-disp)', fontSize: isHigh ? 15 : 13,
            fontWeight: 800, color: col.main,
            letterSpacing: isHigh ? '0.03em' : '0.01em',
            lineHeight: 1.3, marginBottom: 6,
          }}>
            {title}
          </div>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            color: isHigh ? 'rgba(255,69,96,0.8)' : 'rgba(255,176,32,0.75)',
            letterSpacing: '0.05em',
          }}>
            {sub}
          </div>
        </div>

        {/* Recommendations list */}
        <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 12px', borderRadius: 10,
              background: r.urgent ? col.dim : 'rgba(255,255,255,0.03)',
              border: `1px solid ${r.urgent ? col.border : 'rgba(255,255,255,0.06)'}`,
            }}>
              <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>{r.icon}</span>
              <span style={{
                fontFamily: 'var(--font-body)', fontSize: 13, lineHeight: 1.5,
                color: r.urgent ? col.main : 'var(--text-2)',
                fontWeight: r.urgent ? 600 : 400,
              }}>
                {r.text}
              </span>
            </div>
          ))}
        </div>

        {/* Action footer */}
        <div style={{
          padding: '12px 20px 18px',
          borderTop: `1px solid ${col.main}22`,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {isHigh && (
            <a href="tel:112" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '12px', borderRadius: 10,
              background: '#ff4560', color: '#fff',
              fontFamily: 'var(--font-disp)', fontSize: 14, fontWeight: 800,
              textDecoration: 'none', letterSpacing: '0.03em',
              boxShadow: '0 0 20px rgba(255,69,96,0.5)',
            }}>
              📞 Call Emergency (112)
            </a>
          )}
          <button
            onClick={onDismiss}
            style={{
              padding: '11px', borderRadius: 10,
              background: isHigh ? 'rgba(255,69,96,0.12)' : 'rgba(255,176,32,0.12)',
              border: `1px solid ${col.main}44`,
              color: col.main,
              fontFamily: 'var(--font-disp)', fontSize: 13, fontWeight: 700,
              letterSpacing: '0.04em',
              transition: 'background 0.2s',
            }}
          >
            {isHigh ? 'I Understand — Dismiss Alarm' : 'Understood — Dismiss'}
          </button>
          {isLow && (
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 9,
              color: 'var(--text-3)', textAlign: 'center', letterSpacing: '0.06em',
            }}>
              TAP OUTSIDE OR DISMISS TO CLOSE
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes popIn {
          from { opacity: 0; transform: translate(-50%, -48%) scale(0.93) }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1) }
        }
      `}</style>
    </>
  )
}

// ─── Arc Gauge ─────────────────────────────────────────────────────────────
function ArcGauge({ value, color, size = 160 }) {
  const r = size * 0.38, cx = size / 2, cy = size / 2
  const startAngle = -210, totalArc = 240
  const safeValue = isNaN(value) || value == null ? 0 : Math.min(100, Math.max(0, value))
  const valueArc = (safeValue / 100) * totalArc
  const toRad = a => (a * Math.PI) / 180
  const arcPath = (startA, endA) => {
    const x1 = cx + r * Math.cos(toRad(startA)), y1 = cy + r * Math.sin(toRad(startA))
    const x2 = cx + r * Math.cos(toRad(endA)),   y2 = cy + r * Math.sin(toRad(endA))
    const la = Math.abs(endA - startA) > 180 ? 1 : 0
    return `M ${x1} ${y1} A ${r} ${r} 0 ${la} 1 ${x2} ${y2}`
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      <path d={arcPath(startAngle, startAngle + totalArc)} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={size * 0.07} strokeLinecap="round" />
      <path d={arcPath(startAngle, startAngle + valueArc)} fill="none" stroke={color} strokeWidth={size * 0.07} strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: 'all 1s cubic-bezier(0.34, 1.56, 0.64, 1)' }} />
      <text x={cx} y={cy - 4} textAnchor="middle" fill={color}
        style={{ fontFamily: "'Outfit',sans-serif", fontSize: size * 0.22, fontWeight: 800, transition: 'fill 0.4s' }}>
        {Math.round(safeValue)}%
      </text>
      <text x={cx} y={cy + size * 0.13} textAnchor="middle" fill="var(--text-3)"
        style={{ fontFamily: "'DM Mono',monospace", fontSize: size * 0.074, letterSpacing: '0.1em' }}>
        GAS LEVEL
      </text>
    </svg>
  )
}

// ─── PPM bar ───────────────────────────────────────────────────────────────
function PpmBar({ ppm }) {
  const MAX = 1000
  const displayPpm = filterPpm(ppm)
  const pct = Math.min(100, ((displayPpm || 0) / MAX) * 100)
  const col = displayPpm >= 500 ? '#ff4560' : displayPpm >= 300 ? '#ffb020' : '#00e5a0'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
        <span>MQ6 concentration</span>
        <span style={{ color: displayPpm ? col : 'var(--text-3)', fontWeight: 600 }}>
          {displayPpm != null ? `~${Math.round(displayPpm)} ppm` : '0 ppm'}
        </span>
      </div>
      <div style={{ background: 'var(--surface3)', borderRadius: 6, height: 7, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 6, background: `linear-gradient(90deg, #00e5a0, ${col})`, transition: 'width 1s ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)' }}>
        <span>0</span><span>300</span><span>500</span><span>1000 ppm</span>
      </div>
    </div>
  )
}

// ─── BarChart ──────────────────────────────────────────────────────────────
function BarChart({ data, color, showValues = true, yAxisLabel = '' }) {
  if (!data || data.length === 0) return (
    <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>No data yet</div>
  )
  const maxRaw = Math.max(...data.map(d => d.value))
  const max = maxRaw > 0 ? maxRaw : 1
  const hasAnyData = maxRaw > 0
  const barAreaHeight = 110
  const yAxisWidth = 40
  const yTicks = hasAnyData
    ? [0, Math.round(max * 0.25), Math.round(max * 0.5), Math.round(max * 0.75), max]
    : [0, 25, 50, 75, 100]

  return (
    <div style={{ width: '100%' }}>
      {!hasAnyData && (
        <div style={{ textAlign: 'center', padding: '8px 0 4px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.08em' }}>
          — No readings in this period —
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ width: yAxisWidth, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: barAreaHeight, paddingRight: 8, borderRight: '1px solid var(--border)', marginRight: 8 }}>
          {yTicks.slice().reverse().map((tick, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', textAlign: 'right', lineHeight: 1 }}>{tick}</div>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: barAreaHeight, width: '100%', borderBottom: '1px solid var(--border)' }}>
            {data.map((d, i) => {
              const usableHeight = barAreaHeight - 22
              const barH = hasAnyData && d.value > 0 ? Math.max(4, (d.value / max) * usableHeight) : 0
              const isToday = d.isToday
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end', minWidth: 0 }}>
                  <div style={{ width: '100%', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}>
                    {showValues && d.value > 0 && (
                      <div style={{ position: 'absolute', bottom: barH + 4, left: '50%', transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)', fontSize: 9, color: color, fontWeight: 600, whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.75)', padding: '2px 5px', borderRadius: 4, pointerEvents: 'none', zIndex: 1 }}>
                        {d.value}
                      </div>
                    )}
                    <div style={{ width: '85%', height: barH > 0 ? barH : 2, borderRadius: '3px 3px 0 0', background: barH > 0 ? color : 'rgba(255,255,255,0.08)', transition: 'height 0.6s cubic-bezier(.4,0,.2,1)', boxShadow: barH > 0 ? `0 0 8px ${color}44` : 'none', outline: isToday ? `2px solid ${color}` : 'none', outlineOffset: 2 }} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: isToday ? color : 'var(--text-3)', fontWeight: isToday ? 700 : 400, marginTop: 2 }}>{d.label}</span>
                </div>
              )
            })}
          </div>
          {yAxisLabel && (
            <div style={{ textAlign: 'center', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)' }}>{yAxisLabel}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── DualBarChart ──────────────────────────────────────────────────────────
function DualBarChart({ data, showValues = true }) {
  if (!data || data.length === 0) return (
    <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>No data yet</div>
  )
  const maxRaw = Math.max(...data.map(d => Math.max(d.high, d.low)))
  const max = maxRaw > 0 ? maxRaw : 1
  const hasAnyData = maxRaw > 0
  const barAreaHeight = 110
  const yAxisWidth = 40
  const yTicks = hasAnyData
    ? [0, Math.round(max * 0.25), Math.round(max * 0.5), Math.round(max * 0.75), max]
    : [0, 1, 2, 3, 4]
  const usableHeight = barAreaHeight - 22

  return (
    <div style={{ width: '100%' }}>
      {!hasAnyData && (
        <div style={{ textAlign: 'center', padding: '8px 0 4px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.08em' }}>
          — No leak events in this period —
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ width: yAxisWidth, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: barAreaHeight, paddingRight: 8, borderRight: '1px solid var(--border)', marginRight: 8 }}>
          {yTicks.slice().reverse().map((tick, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', textAlign: 'right', lineHeight: 1 }}>{tick}</div>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: barAreaHeight, width: '100%', borderBottom: '1px solid var(--border)' }}>
            {data.map((d, i) => {
              const highH = d.high > 0 ? Math.max(4, (d.high / max) * usableHeight) : 0
              const lowH  = d.low  > 0 ? Math.max(4, (d.low  / max) * usableHeight) : 0
              const dayMax = Math.max(highH, lowH)
              const isToday = d.isToday
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end', minWidth: 0 }}>
                  <div style={{ width: '100%', display: 'flex', gap: 2, alignItems: 'flex-end', justifyContent: 'center', position: 'relative', height: dayMax > 0 ? dayMax + 24 : 20 }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', position: 'relative' }}>
                      {showValues && d.high > 0 && (
                        <div style={{ position: 'absolute', bottom: highH + 2, left: '50%', transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)', fontSize: 8, color: '#ff4560', fontWeight: 700, whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.75)', padding: '1px 4px', borderRadius: 3, pointerEvents: 'none', zIndex: 1 }}>{d.high}</div>
                      )}
                      <div style={{ width: '90%', height: highH > 0 ? highH : 2, borderRadius: '2px 2px 0 0', background: highH > 0 ? '#ff4560' : 'rgba(255,69,96,0.12)', boxShadow: highH > 0 ? '0 0 6px rgba(255,69,96,0.4)' : 'none', transition: 'height 0.6s cubic-bezier(.4,0,.2,1)' }} />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', position: 'relative' }}>
                      {showValues && d.low > 0 && (
                        <div style={{ position: 'absolute', bottom: lowH + 2, left: '50%', transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)', fontSize: 8, color: '#ffb020', fontWeight: 700, whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.75)', padding: '1px 4px', borderRadius: 3, pointerEvents: 'none', zIndex: 1 }}>{d.low}</div>
                      )}
                      <div style={{ width: '90%', height: lowH > 0 ? lowH : 2, borderRadius: '2px 2px 0 0', background: lowH > 0 ? '#ffb020' : 'rgba(255,176,32,0.12)', boxShadow: lowH > 0 ? '0 0 6px rgba(255,176,32,0.4)' : 'none', transition: 'height 0.6s cubic-bezier(.4,0,.2,1)' }} />
                    </div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: isToday ? '#ffb020' : 'var(--text-3)', fontWeight: isToday ? 700 : 400 }}>{d.label}</span>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-2)' }}>
              <span style={{ width: 10, height: 10, background: '#ff4560', borderRadius: 2, display: 'inline-block' }}></span>High Leaks
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-2)' }}>
              <span style={{ width: 10, height: 10, background: '#ffb020', borderRadius: 2, display: 'inline-block' }}></span>Low Leaks
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sparkline ────────────────────────────────────────────────────────────
function Sparkline({ data, color, height = 40 }) {
  if (!data || data.length < 2) return null
  const w = 200, h = height, pad = 4
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1
  const pts = data.map((v, i) => [pad + (i / (data.length - 1)) * (w - pad * 2), h - pad - ((v - min) / range) * (h - pad * 2)])
  const line = pts.map(p => p.join(',')).join(' ')
  const area = `M${pad},${h} L${pts.map(p => p.join(',')).join(' L')} L${w - pad},${h} Z`
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg-${color.replace('#', '')})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ─── Cylinder Selector ────────────────────────────────────────────────────
function CylinderSelector({ selectedId, onChange }) {
  return (
    <div>
      <SectionTitle>⚖️ Gas Cylinder Size</SectionTitle>
      <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.6 }}>
        Select your LPG cylinder size. This tells the app how much gas a full cylinder holds (net_g), used to calculate the percentage.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {CYLINDER_PRESETS.map(p => {
          const active = p.id === selectedId
          return (
            <button key={p.id} onClick={() => onChange(p.id)} style={{
              padding: '14px 8px', borderRadius: 'var(--r-sm)',
              border: active ? '1.5px solid #4d8eff' : '1px solid var(--border)',
              background: active ? 'rgba(77,142,255,0.12)' : 'var(--surface2)',
              color: active ? '#4d8eff' : 'var(--text-2)',
              fontFamily: 'var(--font-disp)', fontSize: 18, fontWeight: 800,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              transition: 'all 0.2s',
            }}>
              {p.label}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: active ? 'rgba(77,142,255,0.8)' : 'var(--text-3)', fontWeight: 400 }}>{(p.net_g / 1000).toFixed(0)}kg gas</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', fontWeight: 400 }}>tare ~{(p.tare_g / 1000).toFixed(0)}kg</span>
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface2)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', lineHeight: 1.7 }}>
        Formula (tare set): <span style={{ color: 'var(--text-2)' }}>(total_weight − tare) ÷ net_gas × 100</span><br />
        Formula (no tare): <span style={{ color: 'var(--text-2)' }}>total_weight ÷ net_gas × 100</span>
      </div>
    </div>
  )
}

// ─── Cooking Mode Toggle ──────────────────────────────────────────────────
function CookingModeToggle({ active, onToggle }) {
  return (
    <button onClick={onToggle} title={active ? 'Cooking Mode ON — tap to disable' : 'Pause MQ6 alerts while cooking'} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20,
      border: active ? '1px solid rgba(255,176,32,0.5)' : '1px solid var(--border)',
      background: active ? 'rgba(255,176,32,0.12)' : 'var(--surface2)',
      color: active ? '#ffb020' : 'var(--text-3)',
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
      transition: 'all 0.25s', letterSpacing: '0.04em', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 13 }}>🍳</span>
      {active ? 'COOKING ON' : 'COOKING'}
    </button>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState('dashboard')

  // ── Persisted weight state ─────────────────────────────────────────────
  const [rawWeightG, setRawWeightGState] = useState(() => lsGet('gaswatch_last_weight'))
  const setRawWeightG = (w) => {
    setRawWeightGState(w)
    if (w != null) lsSet('gaswatch_last_weight', w)
  }

  const [levelHistory, setLevelHistory] = useState([])
  const [connected, setConnected]       = useState(false)
  const [lastSeen, setLastSeen]         = useState(new Date())
  const [loaded, setLoaded]             = useState(false)
  const [demoMode]                      = useState(!isConfigured())

  const [cylinderId, setCylinderIdRaw] = useState(() => localStorage.getItem('gaswatch_cylinder') || DEFAULT_CYLINDER)
  const cylinderPreset = CYLINDER_PRESETS.find(p => p.id === cylinderId) || CYLINDER_PRESETS[1]

  const [customTare_g, setCustomTare_g] = useState(() => {
    const v = localStorage.getItem('gaswatch_custom_tare')
    return v != null ? parseFloat(v) : null
  })
  const setCustomTare = (val) => {
    setCustomTare_g(val)
    if (val == null) localStorage.removeItem('gaswatch_custom_tare')
    else localStorage.setItem('gaswatch_custom_tare', String(val))
  }
  const customTareRef = useRef(customTare_g)
  useEffect(() => { customTareRef.current = customTare_g }, [customTare_g])

  const gasLevel = rawWeightG != null ? weightToPercent(rawWeightG, cylinderPreset, customTare_g) : 0

  const cylinderPresetRef = useRef(cylinderPreset)
  useEffect(() => { cylinderPresetRef.current = cylinderPreset }, [cylinderPreset])

  const setCylinderId = id => {
    setCylinderIdRaw(id)
    localStorage.setItem('gaswatch_cylinder', id)
  }

  useEffect(() => {
    if (rawWeightG == null) return
    const pct = weightToPercent(rawWeightG, cylinderPreset, customTare_g)
    setLevelHistory(prev => [...prev.slice(-59), pct])
  }, [rawWeightG, cylinderPreset, customTare_g])

  // ── Weekly chart state — seeded from localStorage cache ────────────────
  const [weeklyUsage, setWeeklyUsageState]           = useState(() => lsGet('gaswatch_weekly_usage', []))
  const [weeklyLeaksBySev, setWeeklyLeaksBySevState] = useState(() => lsGet('gaswatch_weekly_leaks', []))
  const [weeklyPpm, setWeeklyPpmState]               = useState(() => lsGet('gaswatch_weekly_ppm', []))

  const setWeeklyUsage = (data) => {
    setWeeklyUsageState(data)
    lsSet('gaswatch_weekly_usage', data)
    lsSet('gaswatch_weekly_ts', Date.now())
  }
  const setWeeklyLeaksBySev = (data) => {
    setWeeklyLeaksBySevState(data)
    lsSet('gaswatch_weekly_leaks', data)
  }
  const setWeeklyPpm = (data) => {
    setWeeklyPpmState(data)
    lsSet('gaswatch_weekly_ppm', data)
  }

  const [severity, setSeverity]     = useState('safe')
  const [currentPpm, setCurrentPpm] = useState(null)
  const [currentRaw, setCurrentRaw] = useState(null)
  const [ppmHistory, setPpmHistory] = useState([])
  const [alarmBanner, setAlarmBanner] = useState(false)
  const [alerts, setAlerts]           = useState([])
  const [totalLeaks, setTotalLeaks]   = useState(0)

  // ── Safety popup state ─────────────────────────────────────────────────
  // popup: null | { severity, ppm }
  const [safetyPopup, setSafetyPopup] = useState(null)
  // Track last severity to avoid re-popping on same sustained event
  const lastPopupSevRef = useRef('safe')

  const [cookingMode, setCookingModeRaw] = useState(() => localStorage.getItem('gaswatch_cooking') === 'true')
  const [cookingStart, setCookingStart]  = useState(null)
  const cookingRef = useRef(cookingMode)
  const setCookingMode = val => {
    setCookingModeRaw(val); cookingRef.current = val
    localStorage.setItem('gaswatch_cooking', val ? 'true' : 'false')
    if (val) { setCookingStart(Date.now()); setSafetyPopup(null) }
    else { setCookingStart(null); setAlarmBanner(false); clearInterval(alarmTimer.current) }
  }

  const [avgPpm7d, setAvgPpm7d]       = useState(() => lsGet('gaswatch_avg_ppm'))
  const [maxPpm7d, setMaxPpm7d]       = useState(() => lsGet('gaswatch_max_ppm'))
  const [highLeaks7d, setHighLeaks7d] = useState(() => lsGet('gaswatch_high_leaks', 0))
  const [lowLeaks7d, setLowLeaks7d]   = useState(() => lsGet('gaswatch_low_leaks', 0))
  const [avgDailyUse, setAvgDailyUse] = useState(() => lsGet('gaswatch_avg_daily_use'))

  const audioCtx   = useRef(null)
  const alarmTimer = useRef(null)

  useEffect(() => {
    if (!cookingMode || !cookingStart) return
    const ms = 2 * 60 * 60 * 1000 - (Date.now() - cookingStart)
    if (ms <= 0) { setCookingMode(false); return }
    const t = setTimeout(() => setCookingMode(false), ms)
    return () => clearTimeout(t)
  }, [cookingMode, cookingStart])

  const playAlarm = useCallback(() => {
    try {
      if (!audioCtx.current) audioCtx.current = new AudioContext()
      const ctx = audioCtx.current
      [[880, 0], [660, 0.2], [880, 0.4], [660, 0.6]].forEach(([freq, t]) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.type = 'sawtooth'; osc.frequency.value = freq
        gain.gain.setValueAtTime(0.18, ctx.currentTime + t)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18)
        osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.2)
      })
    } catch (_) {}
  }, [])

  const stopAlarm = useCallback(() => {
    setAlarmBanner(false)
    clearInterval(alarmTimer.current)
  }, [])

  // ── Dismiss popup handler — also stops alarm for high severity ─────────
  const dismissPopup = useCallback(() => {
    setSafetyPopup(null)
    stopAlarm()
    lastPopupSevRef.current = 'safe' // allow re-trigger on next event
  }, [stopAlarm])

  // ── Rule-based popup trigger ───────────────────────────────────────────
  const triggerSafetyPopup = useCallback((fSev, fPpm) => {
    if (cookingRef.current) return                      // suppressed in cooking mode
    if (fSev === 'safe') {
      // Clear popup when back to safe
      setSafetyPopup(null)
      lastPopupSevRef.current = 'safe'
      return
    }
    // Only re-trigger if severity changed upward or it's a new event after dismissal
    if (fSev === lastPopupSevRef.current) return        // same sustained severity, don't re-popup
    lastPopupSevRef.current = fSev
    setSafetyPopup({ severity: fSev, ppm: fPpm })
  }, [])

  const handleLeakEvent = useCallback((sev, id, ts, rawPpm, rawAdc) => {
    const fPpm = filterPpm(rawPpm)
    const fSev = deriveSeverity(rawPpm)
    setSeverity(fSev); setLastSeen(new Date(ts || Date.now()))
    setCurrentPpm(fPpm)
    if (fPpm != null) setPpmHistory(h => [...h.slice(-59), fPpm])
    if (rawAdc != null) setCurrentRaw(rawAdc)

    if (cookingRef.current) {
      setAlarmBanner(false); clearInterval(alarmTimer.current)
      return
    }

    if (fSev !== 'safe') {
      const a = {
        id: id || Date.now(), severity: fSev,
        time: fmtTime(ts || Date.now()), date: fmtDate(ts || Date.now()),
        msg: fSev === 'high' ? 'CRITICAL gas leakage detected!' : 'Minor gas leakage detected',
        ppm: fPpm, raw: rawAdc,
      }
      setAlerts(prev => [a, ...prev.slice(0, 99)])

      if (fSev === 'high') {
        setTotalLeaks(t => t + 1)
        setAlarmBanner(true)
        playAlarm()
        clearInterval(alarmTimer.current)
        alarmTimer.current = setInterval(playAlarm, 2500)
      }

      // Rule-based popup
      triggerSafetyPopup(fSev, fPpm)
    } else {
      setAlarmBanner(false)
      clearInterval(alarmTimer.current)
      // Auto-clear popup when back to safe
      setSafetyPopup(null)
      lastPopupSevRef.current = 'safe'
    }
  }, [playAlarm, triggerSafetyPopup])

  // ── Build rolling 7-day chart data ─────────────────────────────────────
  const buildWeeklyCharts = useCallback((wLvls, wLeaks, pr, ct) => {
    const days = getRolling7Days()
    const todayStr = new Date().toDateString()

    const usageSlots = days.map(d => ({ ...d, sum: 0, cnt: 0, isToday: d.dateStr === todayStr }))
    if (wLvls?.length > 0) {
      wLvls.forEach(r => {
        const ds = new Date(r.created_at).toDateString()
        const slot = usageSlots.find(s => s.dateStr === ds)
        if (slot) { slot.sum += weightToPercent(Number(r.weight_grams), pr, ct); slot.cnt++ }
      })
    }
    const usageData = usageSlots.map(s => ({
      label: s.label, value: s.cnt > 0 ? Math.round(s.sum / s.cnt) : 0, isToday: s.isToday,
    }))

    const daysWithData = usageData.filter(d => d.value > 0)
    let computedAvgDaily = null
    if (daysWithData.length >= 2) {
      const drop = daysWithData[0].value - daysWithData[daysWithData.length - 1].value
      computedAvgDaily = Math.max(0, (drop / daysWithData.length)).toFixed(1)
    }

    const leakSlots = days.map(d => ({ ...d, high: 0, low: 0, ppmSum: 0, ppmCnt: 0, isToday: d.dateStr === todayStr }))
    let sumP = 0, cntP = 0, maxP = 0, cH = 0, cL = 0

    if (wLeaks?.length > 0) {
      wLeaks.forEach(r => {
        const ds   = new Date(r.created_at).toDateString()
        const slot  = leakSlots.find(s => s.dateStr === ds)
        const fSev  = deriveSeverity(r.ppm_approx)
        const fPpm  = filterPpm(r.ppm_approx)
        if (slot) {
          if (fSev === 'high') slot.high++
          if (fSev === 'low')  slot.low++
          if (fPpm != null) { slot.ppmSum += fPpm; slot.ppmCnt++ }
        }
        if (fSev === 'high') cH++
        if (fSev === 'low')  cL++
        if (fPpm != null) { sumP += fPpm; cntP++; if (fPpm > maxP) maxP = fPpm }
      })
    }

    const leaksData = leakSlots.map(s => ({ label: s.label, high: s.high, low: s.low, isToday: s.isToday }))
    const ppmData   = leakSlots.map(s => ({
      label: s.label, value: s.ppmCnt > 0 ? Math.round(s.ppmSum / s.ppmCnt) : 0, isToday: s.isToday,
    }))

    const computedAvgPpm  = cntP > 0 ? Math.round(sumP / cntP) : null
    const computedMaxPpm  = maxP > 0 ? Math.round(maxP) : null

    setWeeklyUsage(usageData)
    setWeeklyLeaksBySev(leaksData)
    setWeeklyPpm(ppmData)
    setAvgPpm7d(computedAvgPpm);      lsSet('gaswatch_avg_ppm', computedAvgPpm)
    setMaxPpm7d(computedMaxPpm);      lsSet('gaswatch_max_ppm', computedMaxPpm)
    setHighLeaks7d(cH);               lsSet('gaswatch_high_leaks', cH)
    setLowLeaks7d(cL);                lsSet('gaswatch_low_leaks', cL)
    setAvgDailyUse(computedAvgDaily); lsSet('gaswatch_avg_daily_use', computedAvgDaily)
  }, []) // eslint-disable-line

  useEffect(() => {
    if (demoMode) {
      setTimeout(() => setLoaded(true), 300)

      const days = getRolling7Days()
      const todayStr = new Date().toDateString()
      const demoLevels  = [68, 65, 63, 61, 58, 55, 57]
      const demoHigh    = [0, 1, 0, 0, 1, 0, 1]
      const demoLow     = [1, 1, 2, 0, 2, 1, 0]
      const demoPpmWeek = [0, 350, 220, 0, 420, 310, 0]

      setWeeklyUsage(days.map((d, i) => ({ label: d.label, value: demoLevels[i], isToday: d.dateStr === todayStr })))
      setWeeklyLeaksBySev(days.map((d, i) => ({ label: d.label, high: demoHigh[i], low: demoLow[i], isToday: d.dateStr === todayStr })))
      setWeeklyPpm(days.map((d, i) => ({ label: d.label, value: demoPpmWeek[i], isToday: d.dateStr === todayStr })))

      setRawWeightG(11400)
      setLevelHistory([68, 65, 63, 61, 58, 55, 57])
      setCurrentPpm(null); setCurrentRaw(218)
      setAvgPpm7d(260); setMaxPpm7d(750)
      setHighLeaks7d(3); setLowLeaks7d(7)
      setAvgDailyUse('1.8')
      setPpmHistory([0, 0, 0, 0, 350, 0, 0, 750, 0, 0, 0, 0])
      setAlerts([
        { id: 1, severity: 'high', time: '10:24:15', date: 'Jun 3', msg: 'CRITICAL gas leakage detected!', ppm: 750 },
        { id: 2, severity: 'low',  time: '08:12:03', date: 'Jun 3', msg: 'Minor gas leakage detected',    ppm: 350 },
        { id: 3, severity: 'low',  time: '22:05:41', date: 'Jun 2', msg: 'Minor gas leakage detected',    ppm: 320 },
      ])
      setTotalLeaks(7); setConnected(false)

      const iv = setInterval(() => {
        setRawWeightGState(prev => {
          const nw = genDemoWeight(prev)
          const pr = cylinderPresetRef.current
          const ct = customTareRef.current
          setLevelHistory(h => [...h.slice(-59), weightToPercent(nw, pr, ct)])
          return nw
        })
        const i = demoIdx++ % demoSevs.length
        const fPpm = filterPpm(demoPpm[i])
        const fSev = deriveSeverity(demoPpm[i])
        setSeverity(fSev); setCurrentPpm(fPpm)
        if (fPpm != null) setPpmHistory(h => [...h.slice(-59), fPpm])
        setLastSeen(new Date())

        if (!cookingRef.current && fSev !== 'safe') {
          const a = {
            id: Date.now(), severity: fSev, ppm: fPpm,
            time: fmtTime(Date.now()), date: fmtDate(Date.now()),
            msg: fSev === 'high' ? 'CRITICAL gas leakage detected!' : 'Minor gas leakage detected',
          }
          setAlerts(p => [a, ...p.slice(0, 99)])

          if (fSev === 'high') {
            setTotalLeaks(t => t + 1)
            setAlarmBanner(true)
            playAlarm()
            clearInterval(alarmTimer.current)
            alarmTimer.current = setInterval(playAlarm, 2500)
          }
          // Rule-based popup
          triggerSafetyPopup(fSev, fPpm)
        } else if (fSev === 'safe') {
          setAlarmBanner(false)
          clearInterval(alarmTimer.current)
          setSafetyPopup(null)
          lastPopupSevRef.current = 'safe'
        }
      }, 3500)
      return () => { clearInterval(iv); clearInterval(alarmTimer.current) }
    }

    let levelCh, leakCh
    async function init() {
      const pr = cylinderPresetRef.current
      const ct = customTareRef.current

      const { data: lvls } = await supabase
        .from('gas_levels')
        .select('weight_grams,created_at')
        .order('created_at', { ascending: false })
        .limit(60)

      if (lvls?.length > 0) {
        const latestWeight = Number(lvls[0].weight_grams)
        setRawWeightG(latestWeight)
        setLastSeen(new Date(lvls[0].created_at))
        setConnected(true)
        setLevelHistory(lvls.map(r => weightToPercent(Number(r.weight_grams), pr, ct)).reverse())
      }

      const { data: leaks } = await supabase
        .from('gas_leakages')
        .select('id,severity,raw_value,ppm_approx,created_at')
        .order('created_at', { ascending: false })
        .limit(100)

      if (leaks?.length > 0) {
        const l = leaks[0]
        setSeverity(deriveSeverity(l.ppm_approx))
        setCurrentPpm(filterPpm(l.ppm_approx))
        if (l.raw_value != null) setCurrentRaw(l.raw_value)
        setPpmHistory(leaks.slice(0, 60).map(r => filterPpm(r.ppm_approx) ?? 0).reverse())
        const filtered = leaks.filter(r => deriveSeverity(r.ppm_approx) !== 'safe')
        setAlerts(filtered.map(r => ({
          id: r.id, severity: deriveSeverity(r.ppm_approx),
          time: fmtTime(r.created_at), date: fmtDate(r.created_at),
          msg: r.severity === 'high' ? 'CRITICAL gas leakage detected!' : 'Minor gas leakage detected',
          ppm: filterPpm(r.ppm_approx), raw: r.raw_value,
        })))
        setTotalLeaks(filtered.length)
        setConnected(true)
      }

      const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString()
      const [{ data: wLvls }, { data: wLeaks }] = await Promise.all([
        supabase.from('gas_levels').select('weight_grams,created_at').gte('created_at', sevenAgo).order('created_at', { ascending: true }),
        supabase.from('gas_leakages').select('severity,ppm_approx,created_at').gte('created_at', sevenAgo).order('created_at', { ascending: true }),
      ])

      buildWeeklyCharts(wLvls, wLeaks, pr, ct)
      setLoaded(true)
    }

    init()

    if (supabase) {
      levelCh = supabase.channel('rt-levels')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gas_levels' }, p => {
          const w  = Number(p.new.weight_grams)
          const pr = cylinderPresetRef.current
          const ct = customTareRef.current
          setRawWeightG(w)
          setLastSeen(new Date(p.new.created_at))
          setConnected(true)
          setLevelHistory(prev => [...prev.slice(-59), weightToPercent(w, pr, ct)])

          const todayStr   = new Date().toDateString()
          const todayLabel = new Date().toLocaleDateString([], { weekday: 'short' }).slice(0, 3)
          const newPct     = weightToPercent(w, pr, ct)
          setWeeklyUsageState(prev => {
            const updated = prev.map(entry => {
              if (entry.label !== todayLabel) return entry
              const blended = entry.value > 0 ? Math.round((entry.value + newPct) / 2) : Math.round(newPct)
              return { ...entry, value: blended, isToday: true }
            })
            lsSet('gaswatch_weekly_usage', updated)
            lsSet('gaswatch_weekly_ts', Date.now())
            return updated
          })
        })
        .subscribe()

      leakCh = supabase.channel('rt-leakages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gas_leakages' }, p => {
          const { severity: sev, id, created_at, ppm_approx, raw_value } = p.new
          handleLeakEvent(sev, id, created_at, ppm_approx, raw_value)
          setConnected(true)

          const todayLabel = new Date().toLocaleDateString([], { weekday: 'short' }).slice(0, 3)
          const fSev = deriveSeverity(ppm_approx)
          const fPpm = filterPpm(ppm_approx)

          if (fSev !== 'safe') {
            setWeeklyLeaksBySevState(prev => {
              const updated = prev.map(entry => {
                if (entry.label !== todayLabel) return entry
                return {
                  ...entry,
                  high: fSev === 'high' ? entry.high + 1 : entry.high,
                  low:  fSev === 'low'  ? entry.low  + 1 : entry.low,
                  isToday: true,
                }
              })
              lsSet('gaswatch_weekly_leaks', updated)
              return updated
            })
          }

          if (fPpm != null) {
            setWeeklyPpmState(prev => {
              const updated = prev.map(entry => {
                if (entry.label !== todayLabel) return entry
                const newVal = entry.value > 0 ? Math.round((entry.value + fPpm) / 2) : Math.round(fPpm)
                return { ...entry, value: newVal, isToday: true }
              })
              lsSet('gaswatch_weekly_ppm', updated)
              return updated
            })
          }
        })
        .subscribe()
    }

    return () => {
      if (supabase) {
        if (levelCh) supabase.removeChannel(levelCh)
        if (leakCh)  supabase.removeChannel(leakCh)
      }
      clearInterval(alarmTimer.current)
    }
  }, [demoMode, handleLeakEvent, playAlarm, buildWeeklyCharts, triggerSafetyPopup])

  // ── Derived state ──────────────────────────────────────────────────────
  const displaySev    = cookingMode ? 'safe' : severity
  const displayPpm    = cookingMode ? null   : currentPpm
  const sCol          = cookingMode ? C.safe : C[severity]
  const lCol          = levelColor(gasLevel)
  const rules         = getRecommendations(displaySev, gasLevel, displayPpm)
  const estDays       = gasLevel > 0 ? Math.max(0, Math.ceil(gasLevel / 2.1)) : 0
  const nonSafeAlerts = alerts.filter(a => a.severity !== 'safe')

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '◈' },
    { id: 'alerts',    label: 'Alerts',    icon: '◉', badge: nonSafeAlerts.length },
    { id: 'analytics', label: 'Analytics', icon: '◎' },
    { id: 'device',    label: 'Device',    icon: '◇' },
  ]

  if (!loaded) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
      <div style={{ width: 36, height: 36, border: '2px solid var(--border2)', borderTopColor: '#00e5a0', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.12em' }}>INITIALISING</span>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>

      {/* ── Safety Recommendation Popup (rule-based engine) ─────────────── */}
      {safetyPopup && !cookingMode && (
        <SafetyPopup
          severity={safetyPopup.severity}
          ppm={safetyPopup.ppm}
          onDismiss={dismissPopup}
        />
      )}

      <header style={{
        position: 'sticky', top: 0, zIndex: 200,
        background: 'rgba(10,14,26,0.92)', backdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 16px', height: 56,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'linear-gradient(135deg,#ff6b35,#ff4560)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, boxShadow: '0 0 14px rgba(255,69,96,0.35)' }}>🔥</div>
          <div>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 16, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.02em' }}>
              GasWatch <span style={{ color: '#4d8eff' }}>Pro</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-3)', letterSpacing: '0.12em' }}>
              {demoMode ? 'DEMO MODE' : 'LIVE · IOT MONITORING'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <CookingModeToggle active={cookingMode} onToggle={() => setCookingMode(!cookingMode)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
            <StatusDot online={connected} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: connected ? '#00e5a0' : '#ff4560' }}>
              {connected ? 'LIVE' : demoMode ? 'DEMO' : 'OFFLINE'}
            </span>
          </div>
          <Chip label={displaySev.toUpperCase()} color={sCol.main} border={sCol.border} bg={sCol.dim} />
        </div>
      </header>

      {cookingMode && (
        <div className="slide-down" style={{
          position: 'sticky', top: 56, zIndex: 190,
          background: 'rgba(255,176,32,0.10)', borderBottom: '1px solid rgba(255,176,32,0.25)',
          padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🍳</span>
            <div>
              <div style={{ fontFamily: 'var(--font-disp)', fontWeight: 700, color: '#ffb020', fontSize: 12 }}>Cooking Mode — MQ6 paused</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,176,32,0.7)', marginTop: 1 }}>Auto-off after 2 hours</div>
            </div>
          </div>
          <button onClick={() => setCookingMode(false)} style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: 'rgba(255,176,32,0.2)', border: '1px solid rgba(255,176,32,0.4)', color: '#ffb020' }}>Off</button>
        </div>
      )}

      {/* Sticky alarm banner (only shown separately from popup for non-high alarms or when popup dismissed) */}
      {alarmBanner && !cookingMode && !safetyPopup && (
        <div className="slide-down" style={{
          position: 'sticky', top: cookingMode ? 112 : 56, zIndex: 190,
          background: 'rgba(255,69,96,0.12)', borderBottom: '1px solid rgba(255,69,96,0.3)',
          padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          animation: 'shimmer 0.8s ease infinite',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20, flexShrink: 0 }}>🚨</span>
            <div>
              <div style={{ fontFamily: 'var(--font-disp)', fontWeight: 700, color: '#ff4560', fontSize: 13 }}>
                CRITICAL LEAK{currentPpm ? ` · ~${Math.round(currentPpm)} ppm` : ''}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,69,96,0.8)', marginTop: 1 }}>
                Evacuate · Cut power · Call emergency
              </div>
            </div>
          </div>
          <button onClick={stopAlarm} style={{ padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: '#ff4560', color: '#fff', boxShadow: '0 0 14px rgba(255,69,96,0.4)', flexShrink: 0 }}>
            Dismiss
          </button>
        </div>
      )}

      <nav id="desktop-nav" style={{
        background: 'rgba(10,14,26,0.8)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 12px', overflowX: 'auto', gap: 0,
        WebkitOverflowScrolling: 'touch',
      }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            padding: '14px 18px', fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-body)',
            color: tab === n.id ? '#f0f4ff' : 'var(--text-3)',
            borderBottom: `2px solid ${tab === n.id ? '#4d8eff' : 'transparent'}`,
            borderRadius: 0, whiteSpace: 'nowrap', transition: 'color 0.2s',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>{n.icon}</span>{n.label}
            {n.badge > 0 && (
              <span style={{ background: '#ff4560', color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: 10, padding: '1px 5px', fontFamily: 'var(--font-mono)' }}>
                {n.badge > 99 ? '99+' : n.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main id="main-content" className="fade-up" style={{ flex: 1, padding: '16px', maxWidth: 960, width: '100%', margin: '0 auto', minWidth: 0, overflowX: 'hidden' }}>
        {tab === 'dashboard' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <DashboardTab
              gasLevel={gasLevel} lCol={lCol} rawWeightG={rawWeightG} cylinderPreset={cylinderPreset}
              levelHistory={levelHistory} severity={severity} displaySev={displaySev}
              displayPpm={displayPpm} currentPpm={currentPpm} sCol={sCol} ppmHistory={ppmHistory}
              cookingMode={cookingMode} estDays={estDays} totalLeaks={totalLeaks} rules={rules}
            />
          </div>
        )}
        {tab === 'alerts' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <AlertsTab nonSafeAlerts={nonSafeAlerts} setAlerts={setAlerts} />
          </div>
        )}
        {tab === 'analytics' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <AnalyticsTab
              estDays={estDays} avgPpm7d={avgPpm7d} maxPpm7d={maxPpm7d}
              highLeaks7d={highLeaks7d} lowLeaks7d={lowLeaks7d} avgDailyUse={avgDailyUse}
              weeklyUsage={weeklyUsage} weeklyLeaksBySev={weeklyLeaksBySev} weeklyPpm={weeklyPpm}
              gasLevel={gasLevel} cylinderPreset={cylinderPreset} levelHistory={levelHistory}
              rawWeightG={rawWeightG}
            />
          </div>
        )}
        {tab === 'device' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <DeviceTab
              cylinderId={cylinderId} setCylinderId={setCylinderId}
              connected={connected} demoMode={demoMode} lastSeen={lastSeen}
              displaySev={displaySev} displayPpm={displayPpm} currentRaw={currentRaw}
              cookingMode={cookingMode} avgPpm7d={avgPpm7d} maxPpm7d={maxPpm7d} sCol={sCol}
              rawWeightG={rawWeightG} cylinderPreset={cylinderPreset}
              customTare_g={customTare_g} setCustomTare={setCustomTare}
              gasLevel={gasLevel}
            />
          </div>
        )}
      </main>

      <nav id="mobile-nav" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
        background: 'rgba(10,14,26,0.97)', backdropFilter: 'blur(16px)',
        borderTop: '1px solid var(--border)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        <div style={{ display: 'flex', height: 60 }}>
          {navItems.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, padding: '8px 4px', position: 'relative',
              color: tab === n.id ? '#f0f4ff' : 'var(--text-3)',
              transition: 'color 0.2s',
            }}>
              {tab === n.id && (
                <div style={{ position: 'absolute', top: 6, width: 4, height: 4, borderRadius: '50%', background: '#4d8eff' }} />
              )}
              <span style={{ fontSize: 18, lineHeight: 1 }}>{n.icon}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: '0.05em' }}>{n.label}</span>
              {n.badge > 0 && (
                <span style={{ position: 'absolute', top: 8, right: '14%', background: '#ff4560', color: '#fff', fontSize: 8, fontWeight: 700, borderRadius: 8, padding: '0 4px', fontFamily: 'var(--font-mono)' }}>
                  {n.badge > 99 ? '99+' : n.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD TAB
// ══════════════════════════════════════════════════════════════════════════
function DashboardTab({ gasLevel, lCol, rawWeightG, cylinderPreset, levelHistory, severity, displaySev, displayPpm, currentPpm, sCol, ppmHistory, cookingMode, estDays, totalLeaks, rules }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: '100%' }}>
        <Card accent={lCol.main} glow={lCol.glow} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 12px', minWidth: 0 }}>
          <SectionTitle style={{ marginBottom: 10 }}>Cylinder Level</SectionTitle>
          <ArcGauge value={gasLevel} color={lCol.main} size={130} />
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <Chip
              label={gasLevel < 20 ? '⚠ Replace Now' : gasLevel < 40 ? '⚠ Plan Refill' : '✓ Sufficient'}
              color={lCol.main} border={lCol.border} bg={lCol.dim}
            />
            {rawWeightG != null && (
              <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', letterSpacing: '0.06em' }}>
                {(rawWeightG / 1000).toFixed(2)} kg · {cylinderPreset.label}
              </div>
            )}
          </div>
        </Card>

        <Card accent={sCol.main} glow={displaySev !== 'safe' ? sCol.glow : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '20px 12px', minWidth: 0 }}>
          <SectionTitle style={{ marginBottom: 6 }}>Leak Status</SectionTitle>
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: sCol.dim, border: `1.5px solid ${sCol.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30,
            boxShadow: displaySev !== 'safe' ? sCol.glow : undefined,
            animation: displaySev === 'high' ? 'pulseRed 1.2s ease infinite' : displaySev === 'safe' ? 'pulseGreen 3s ease infinite' : undefined,
          }}>
            {cookingMode ? '🍳' : displaySev === 'high' ? '🚨' : displaySev === 'low' ? '⚠️' : '✅'}
          </div>
          <div style={{ fontFamily: 'var(--font-disp)', fontSize: 16, fontWeight: 800, color: sCol.main, textAlign: 'center' }}>
            {cookingMode ? 'PAUSED' : displaySev === 'high' ? 'CRITICAL' : displaySev === 'low' ? 'LOW LEAK' : 'ALL SAFE'}
          </div>
          <Chip label={cookingMode ? 'COOKING' : displaySev.toUpperCase()} color={sCol.main} border={sCol.border} bg={sCol.dim} />
        </Card>
      </div>

      <Card>
        <SectionTitle>MQ6 Gas Concentration</SectionTitle>
        <PpmBar ppm={displayPpm} />
        {ppmHistory.filter(v => v > 0).length > 2 && !cookingMode && (
          <div style={{ marginTop: 10 }}>
            <Sparkline data={ppmHistory} color={sCol.main} height={32} />
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 3, textAlign: 'center', letterSpacing: '0.07em' }}>PPM TREND (≥300 only)</div>
          </div>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, width: '100%' }}>
        {[
          { label: 'Days Left',   val: `~${estDays}d`,             col: '#4d8eff' },
          { label: 'Gas Level',   val: `${Math.round(gasLevel)}%`, col: lCol.main },
          { label: 'Leak Events', val: totalLeaks,                  col: '#ff4560' },
        ].map((s, i) => (
          <Card key={i} style={{ textAlign: 'center', padding: '14px 8px', minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 24, fontWeight: 800, color: s.col, lineHeight: 1 }}>{s.val}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</div>
          </Card>
        ))}
      </div>

      {levelHistory.length > 2 && (
        <Card>
          <SectionTitle>Level Trend · Last {Math.min(levelHistory.length, 60)} Readings</SectionTitle>
          <Sparkline data={levelHistory} color={lCol.main} height={48} />
        </Card>
      )}

      <Card accent={sCol.main}>
        <SectionTitle>⚡ Safety Recommendations</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((r, i) => (
            <div key={i} style={{
              padding: '10px 12px', borderRadius: 'var(--r-sm)',
              background: r.urgent ? sCol.dim : 'var(--surface2)',
              border: `1px solid ${r.urgent ? sCol.border : 'var(--border)'}`,
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>{r.icon}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, lineHeight: 1.5, color: r.urgent ? sCol.main : 'var(--text-2)', fontWeight: r.urgent ? 600 : 400 }}>
                {r.text}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// ALERTS TAB
// ══════════════════════════════════════════════════════════════════════════
function AlertsTab({ nonSafeAlerts, setAlerts }) {
  return (
    <Card style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <SectionTitle style={{ marginBottom: 4 }}>Alert History · MQ6</SectionTitle>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
            {nonSafeAlerts.length} leak event{nonSafeAlerts.length !== 1 ? 's' : ''} · ≥300 ppm only
          </div>
        </div>
        <button onClick={() => setAlerts([])} style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-2)', flexShrink: 0 }}>
          Clear All
        </button>
      </div>
      {nonSafeAlerts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--text-3)' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🛡️</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, marginBottom: 4 }}>No leakage events recorded</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>All MQ6 readings below 300 ppm</div>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        {nonSafeAlerts.map(a => {
          const ac = C[a.severity]
          return (
            <div key={a.id} style={{ padding: '12px 14px', borderRadius: 'var(--r-sm)', background: ac.dim, border: `1px solid ${ac.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{a.severity === 'high' ? '🚨' : '⚠️'}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: ac.main }}>{a.msg}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>{a.date} · {a.time}</span>
                    {a.ppm != null && <span style={{ color: ac.main }}>~{Math.round(a.ppm)} ppm</span>}
                  </div>
                </div>
              </div>
              <Chip label={a.severity.toUpperCase()} color={ac.main} border={ac.border} bg={ac.dim} style={{ flexShrink: 0 }} />
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ══════════════════════════════════════════════════════════════════════════
function AnalyticsTab({ estDays, avgPpm7d, maxPpm7d, highLeaks7d, lowLeaks7d, avgDailyUse, weeklyUsage, weeklyLeaksBySev, weeklyPpm, gasLevel, cylinderPreset, levelHistory, rawWeightG }) {
  const lCol = levelColor(gasLevel)
  const todayLabel = new Date().toLocaleDateString([], { weekday: 'long' })

  const statRows = [
    { label: 'Days Remaining',  val: `~${estDays}d`,                                              col: '#00e5a0' },
    { label: 'Avg Daily Use',   val: avgDailyUse != null ? `~${avgDailyUse}%/day` : '—',          col: '#4d8eff' },
    { label: 'Avg PPM (7d)',    val: avgPpm7d != null ? `${avgPpm7d} ppm` : '0 ppm',              col: '#ffb020' },
    { label: 'Peak PPM (7d)',   val: maxPpm7d != null ? `${maxPpm7d} ppm` : '0 ppm',              col: '#ff4560' },
    { label: 'High Leaks 7d',  val: highLeaks7d,                                                   col: '#ff4560' },
    { label: 'Low Leaks 7d',   val: lowLeaks7d,                                                    col: '#ffb020' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
      <div style={{ padding: '10px 14px', borderRadius: 'var(--r)', background: 'rgba(77,142,255,0.07)', border: '1px solid rgba(77,142,255,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4d8eff', boxShadow: '0 0 8px #4d8eff', flexShrink: 0 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#4d8eff', fontWeight: 600 }}>TODAY — {todayLabel.toUpperCase()}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', marginLeft: 4 }}>highlighted bars = today's data</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, width: '100%' }}>
        {statRows.map((s, i) => (
          <Card key={i} style={{ textAlign: 'center', padding: '16px 10px', minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 26, fontWeight: 800, color: s.col, lineHeight: 1 }}>{s.val}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</div>
          </Card>
        ))}
      </div>

      <Card>
        <SectionTitle>Weekly Gas Level (avg % per day)</SectionTitle>
        <BarChart data={weeklyUsage} color="#4d8eff" showValues={true} />
        <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
          {cylinderPreset.label} cylinder · ~{estDays} days remaining
        </div>
      </Card>

      <Card>
        <SectionTitle>Weekly Leak Events · MQ6</SectionTitle>
        <DualBarChart data={weeklyLeaksBySev} showValues={true} />
      </Card>

      <Card>
        <SectionTitle>Weekly Average PPM (≥300 ppm only)</SectionTitle>
        <BarChart data={weeklyPpm} color="#ffb020" showValues={true} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', flexWrap: 'wrap', gap: 8 }}>
          <span>7d avg: {avgPpm7d != null ? `${avgPpm7d} ppm` : '0 ppm'}</span>
          <span style={{ color: maxPpm7d > 500 ? '#ff4560' : maxPpm7d > 300 ? '#ffb020' : 'var(--text-3)' }}>
            peak: {maxPpm7d != null ? `${maxPpm7d} ppm` : '0 ppm'}
          </span>
        </div>
      </Card>

      {levelHistory.length > 2 && (
        <Card>
          <SectionTitle>Gas Level Trend · Last {Math.min(levelHistory.length, 60)} Readings</SectionTitle>
          <div style={{ height: 80 }}><Sparkline data={levelHistory} color={lCol.main} height={80} /></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', flexWrap: 'wrap', gap: 8 }}>
            <span>oldest</span>
            <span>now: {Math.round(gasLevel)}%{rawWeightG != null ? ` (${(rawWeightG / 1000).toFixed(2)} kg)` : ''}</span>
          </div>
        </Card>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// DEVICE TAB
// ══════════════════════════════════════════════════════════════════════════
function DeviceTab({ cylinderId, setCylinderId, connected, demoMode, lastSeen, displaySev, displayPpm,
  currentRaw, cookingMode, avgPpm7d, maxPpm7d, sCol,
  rawWeightG, cylinderPreset, customTare_g, setCustomTare, gasLevel }) {

  const [tareInput, setTareInput] = useState(customTare_g != null ? String(customTare_g / 1000) : '')
  const [tareMsg, setTareMsg]     = useState(null)

  const usingCustomTare = customTare_g != null
  const modeLabel = usingCustomTare
    ? `Cylinder tare: ${(customTare_g / 1000).toFixed(2)} kg — gas = (received − tare) ÷ net × 100`
    : 'No cylinder tare set — received weight used as gas weight (inflated %)'
  const modeColor = usingCustomTare ? '#00e5a0' : '#ffb020'

  const handleSaveTare = () => {
    const kg = parseFloat(tareInput)
    if (isNaN(kg) || kg < 1 || kg > 30) { setTareMsg({ text: 'Enter a valid tare weight between 1–30 kg', ok: false }); return }
    setCustomTare(kg * 1000)
    setTareMsg({ text: `✓ Cylinder tare set to ${kg.toFixed(2)} kg — gas % recalculated`, ok: true })
    setTimeout(() => setTareMsg(null), 4000)
  }

  const handleClearTare = () => {
    setCustomTare(null); setTareInput('')
    setTareMsg({ text: 'Cylinder tare cleared — received weight used as gas weight', ok: true })
    setTimeout(() => setTareMsg(null), 3000)
  }

  const handleStampTare = () => {
    if (rawWeightG == null) return
    const kg = rawWeightG / 1000
    setTareInput(kg.toFixed(3))
    setCustomTare(rawWeightG)
    setTareMsg({ text: `✓ Cylinder tare stamped at ${kg.toFixed(3)} kg`, ok: true })
    setTimeout(() => setTareMsg(null), 4000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>

      <Card style={{ marginBottom: 0, minWidth: 0 }}>
        <CylinderSelector selectedId={cylinderId} onChange={setCylinderId} />
      </Card>

      <Card accent="#4d8eff" style={{ minWidth: 0 }}>
        <SectionTitle>⚖️ Cylinder Tare Weight</SectionTitle>
        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-sm)', marginBottom: 14, background: 'var(--surface2)', border: '1px solid var(--border)', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7 }}>
          <strong style={{ color: 'var(--text-1)' }}>How it works:</strong><br />
          The ESP32 already removes the board weight automatically on boot.
          What it sends here is <strong style={{ color: 'var(--text-1)' }}>cylinder + gas weight</strong>.<br /><br />
          To calculate accurate gas percentage, enter the weight of your
          <strong style={{ color: 'var(--text-1)' }}> empty cylinder</strong> (no gas inside).
          This is usually printed on the cylinder body as <strong style={{ color: 'var(--text-1)' }}>T</strong> or <strong style={{ color: 'var(--text-1)' }}>Tare</strong>.
        </div>

        <div style={{ padding: '10px 14px', borderRadius: 'var(--r-sm)', marginBottom: 16, background: 'var(--surface2)', border: `1px solid ${modeColor}44`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: modeColor, flexShrink: 0, boxShadow: `0 0 8px ${modeColor}` }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: modeColor, fontWeight: 600, letterSpacing: '0.05em' }}>
              {usingCustomTare ? 'CYLINDER TARE ACTIVE' : 'NO TARE SET'}
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{modeLabel}</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 22, fontWeight: 800, color: '#4d8eff', lineHeight: 1 }}>{Math.round(gasLevel)}%</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 2 }}>gas level</div>
          </div>
        </div>

        {rawWeightG != null && (
          <div style={{ padding: '10px 14px', borderRadius: 'var(--r-sm)', marginBottom: 14, background: 'var(--surface3)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', lineHeight: 2 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span>Received from ESP32</span>
              <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{(rawWeightG / 1000).toFixed(3)} kg ({rawWeightG.toFixed(0)} g)</span>
            </div>
            {usingCustomTare && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <span>Cylinder tare (empty)</span>
                  <span style={{ color: '#ffb020' }}>− {(customTare_g / 1000).toFixed(3)} kg</span>
                </div>
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 4, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <span>Gas remaining</span>
                  <span style={{ color: '#00e5a0', fontWeight: 700 }}>
                    {Math.max(0, rawWeightG - customTare_g).toFixed(0)} g ({Math.round(gasLevel)}%)
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {rawWeightG != null && (
          <div style={{ padding: '12px 14px', borderRadius: 'var(--r-sm)', marginBottom: 12, background: 'rgba(0,229,160,0.06)', border: '1px solid rgba(0,229,160,0.2)' }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: '#00e5a0', marginBottom: 4 }}>Option A — Empty cylinder on scale right now?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 10 }}>
              Place your <strong style={{ color: 'var(--text-2)' }}>empty cylinder</strong> (no gas) on the scale, wait for a stable reading, then tap to use the current reading as the tare.
            </div>
            <button onClick={handleStampTare} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: 'rgba(0,229,160,0.15)', border: '1px solid rgba(0,229,160,0.4)', color: '#00e5a0', letterSpacing: '0.03em' }}>
              📍 Stamp {rawWeightG != null ? `${(rawWeightG / 1000).toFixed(3)} kg` : '—'} as Cylinder Tare
            </button>
          </div>
        )}

        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-sm)', marginBottom: 12, background: 'rgba(77,142,255,0.06)', border: '1px solid rgba(77,142,255,0.2)' }}>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: '#4d8eff', marginBottom: 4 }}>Option B — Enter cylinder tare manually</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 10 }}>
            Check the sticker on your empty cylinder for the tare weight (marked <strong style={{ color: 'var(--text-2)' }}>T</strong> or <strong style={{ color: 'var(--text-2)' }}>Tare</strong>). Enter it below in kg. For a 6kg cylinder this is typically <strong style={{ color: 'var(--text-2)' }}>8.0 kg</strong>.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input type="number" min="1" max="30" step="0.001" value={tareInput} onChange={e => setTareInput(e.target.value)}
              placeholder={`e.g. ${(cylinderPreset.tare_g / 1000).toFixed(1)}`}
              style={{ flex: 1, minWidth: 100, padding: '8px 12px', borderRadius: 8, background: 'var(--surface3)', border: '1px solid var(--border2)', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none' }}
            />
            <button onClick={handleSaveTare} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: 'rgba(77,142,255,0.15)', border: '1px solid rgba(77,142,255,0.4)', color: '#4d8eff', whiteSpace: 'nowrap' }}>Save Tare</button>
            {customTare_g != null && (
              <button onClick={handleClearTare} style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>Clear</button>
            )}
          </div>
        </div>

        {tareMsg && (
          <div style={{ padding: '10px 14px', borderRadius: 'var(--r-sm)', background: tareMsg.ok ? 'rgba(0,229,160,0.08)' : 'rgba(255,69,96,0.08)', border: `1px solid ${tareMsg.ok ? 'rgba(0,229,160,0.3)' : 'rgba(255,69,96,0.3)'}`, fontFamily: 'var(--font-body)', fontSize: 13, color: tareMsg.ok ? '#00e5a0' : '#ff4560' }}>
            {tareMsg.text}
          </div>
        )}

        <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface3)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', lineHeight: 1.8 }}>
          {usingCustomTare
            ? <>Formula: <span style={{ color: 'var(--text-2)' }}>({rawWeightG?.toFixed(0) ?? 'weight'}g − {customTare_g}g) ÷ {cylinderPreset.net_g}g × 100</span></>
            : <>Formula: <span style={{ color: 'var(--text-2)' }}>{rawWeightG?.toFixed(0) ?? 'weight'}g ÷ {cylinderPreset.net_g}g × 100</span><span style={{ color: '#ffb020' }}> (set tare for accurate %)</span></>
          }
          {' '}· Clamped 0–100%
        </div>
      </Card>

      <Card accent="#4d8eff" style={{ minWidth: 0 }}>
        <SectionTitle>ESP32 Status</SectionTitle>
        {[
          { k: 'Connection',    v: connected ? 'Online' : demoMode ? 'Demo Mode' : 'Offline', col: connected ? '#00e5a0' : demoMode ? '#ffb020' : '#ff4560' },
          { k: 'Last Data',     v: lastSeen.toLocaleTimeString(), col: null },
          { k: 'Protocol',      v: 'HTTP POST → Supabase', col: null },
          { k: 'Send Rate',     v: 'On change (≥50g)', col: null },
          { k: 'Board Tare',    v: 'Auto on boot (ESP32)', col: '#00e5a0' },
          { k: 'Cylinder Tare', v: usingCustomTare ? `${(customTare_g/1000).toFixed(2)} kg (app)` : 'Not set', col: usingCustomTare ? '#00e5a0' : '#ffb020' },
          { k: 'Firmware',      v: 'GasWatch v2.3.0', col: '#4d8eff' },
        ].map((r, i, arr) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-3)', flexShrink: 0 }}>{r.k}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: r.col || 'var(--text-2)', textAlign: 'right' }}>{r.v}</span>
          </div>
        ))}
      </Card>

      <Card style={{ minWidth: 0 }}>
        <SectionTitle>Live MQ6 Readings</SectionTitle>
        {[
          { k: 'Severity',   v: cookingMode ? 'PAUSED' : displaySev.toUpperCase(),               col: cookingMode ? '#ffb020' : sCol.main },
          { k: 'PPM (≥300)', v: displayPpm != null ? `~${Math.round(displayPpm)} ppm` : '0 ppm', col: displayPpm ? sCol.main : 'var(--text-3)' },
          { k: 'Raw ADC',    v: currentRaw != null ? currentRaw : '—',                           col: 'var(--text-2)' },
          { k: '7d Avg PPM', v: avgPpm7d != null ? `${avgPpm7d} ppm` : '0 ppm',                 col: 'var(--text-2)' },
          { k: '7d Peak',    v: maxPpm7d != null ? `${maxPpm7d} ppm` : '0 ppm',                 col: maxPpm7d > 500 ? '#ff4560' : maxPpm7d > 300 ? '#ffb020' : 'var(--text-2)' },
        ].map((r, i, arr) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', flexShrink: 0 }}>{r.k}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: r.col }}>{r.v}</span>
          </div>
        ))}
      </Card>

      <Card style={{ minWidth: 0 }}>
        <SectionTitle>Sensor Health</SectionTitle>
        {[
          { name: 'HX711 Load Cell', type: 'weight_grams via SPI', health: connected ? 100 : 0, col: '#4d8eff' },
          { name: 'MQ6 Gas Sensor',  type: 'severity + ppm_approx', health: connected ? 98 : 0,  col: '#00e5a0' },
        ].map((s, i) => (
          <div key={i} style={{ padding: '12px', background: 'var(--surface2)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', marginBottom: i === 0 ? 8 : 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{s.name}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{s.type}</div>
              </div>
              <Chip label={connected ? 'ACTIVE' : 'OFFLINE'} color={connected ? '#00e5a0' : '#ff4560'} style={{ flexShrink: 0 }} />
            </div>
            <div style={{ background: 'var(--surface3)', borderRadius: 4, height: 5, overflow: 'hidden' }}>
              <div style={{ width: `${s.health}%`, height: '100%', background: s.col, borderRadius: 4, transition: 'width 1s ease' }} />
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', textAlign: 'right', marginTop: 4 }}>{s.health}% health</div>
          </div>
        ))}
      </Card>

      <Card style={{ minWidth: 0 }}>
        <SectionTitle>Integration Notes</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { icon: '🔗', title: 'ESP32 WiFi',     desc: 'Configured via GasMonitor-Setup hotspot on first boot.' },
            { icon: '⚖️', title: 'Board Tare',      desc: 'Handled automatically by ESP32 on every boot using scale.tare(). Board weight is invisible to the app.' },
            { icon: '🪣', title: 'Cylinder Tare',   desc: 'Set above in the app. Subtracts the empty cylinder weight from the received value so the % shows pure gas remaining.' },
            { icon: '📊', title: 'MQ6 Gas Sensor', desc: 'Posts severity, raw_value, ppm_approx every 10 seconds. Readings below 300 ppm are shown as safe.' },
            { icon: '📡', title: 'Realtime',        desc: 'Enable Realtime on both tables in Supabase → Database → Replication.' },
          ].map((c, i) => (
            <div key={i} style={{ padding: '12px', background: 'var(--surface2)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{c.icon}</span>
              <div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{c.title}</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{c.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
