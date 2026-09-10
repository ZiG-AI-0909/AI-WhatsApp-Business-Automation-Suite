import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured } from './supabaseClient.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public landing page — shown to logged-out visitors at the default route.
// Purely presentational/marketing content leading into the existing auth flow
// (WelcomeAuthPage) via the Sign In / Get Started CTAs. Copy is written to be
// generic enough for internal team use and outside customers alike.
// ─────────────────────────────────────────────────────────────────────────────

// Scroll to the section with the given id (plain-JS equivalent of an anchor,
// since the app uses hash-based routing for /login).
const scrollToSection = (id) => () => {
  const element = document.getElementById(id)
  if (element) element.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function LandingLogo() {
  return (
    <div className="landing-logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    </div>
  )
}

const HOW_IT_WORKS_STEPS = [
  {
    icon: '📱',
    title: 'Connect your WhatsApp',
    text: 'Scan a QR code to link your number in seconds — no coding required.',
  },
  {
    icon: '📚',
    title: 'Add your business knowledge',
    text: 'Upload your products, pricing, and policies to the Knowledge Base so the AI knows your business.',
  },
  {
    icon: '🤖',
    title: 'AI replies for you',
    text: 'The AI automatically answers customer messages using that knowledge — toggle it per conversation any time you want to step in personally.',
  },
  {
    icon: '📣',
    title: 'Run bulk campaigns',
    text: 'Send personalized campaigns from an Excel contact list, schedule sends, and track delivery and replies in Analytics.',
  },
]

const FEATURES = [
  {
    icon: '🤖',
    title: 'AI Auto-Reply',
    text: 'Knowledge-base-powered replies with a per-conversation on/off toggle — you stay in control of every chat.',
  },
  {
    icon: '🔗',
    title: 'Two ways to connect',
    text: 'WhatsApp Web (QR) or the official WhatsApp Business API (Meta Cloud API) — choose whichever fits your business.',
  },
  {
    icon: '📣',
    title: 'Bulk Campaigns',
    text: 'Excel contact upload, media attachments, scheduling, and recurring campaigns from one persistent queue.',
  },
  {
    icon: '👥',
    title: 'Contact Management',
    text: 'Organize contacts with tags, notes, and marketing opt-in / opt-out consent tracking.',
  },
  {
    icon: '📝',
    title: 'Message Templates',
    text: 'Reusable message templates with dynamic fields that personalize every message at send time.',
  },
  {
    icon: '📚',
    title: 'Knowledge Base',
    text: 'Upload documents and text — the AI automatically retrieves the relevant context when replying.',
  },
  {
    icon: '📊',
    title: 'Analytics Dashboard',
    text: 'Track message trends, campaign performance, replies, and opt-outs at a glance.',
  },
  {
    icon: '🖼️',
    title: 'Image Lead Extractor',
    text: 'Upload business card or listing photos and the AI extracts structured contact data for you.',
  },
]

const WHY_POINTS = [
  {
    icon: '⚡',
    title: 'Instant responses, even offline',
    text: 'Customers get an immediate answer the moment they message you — nights, weekends, and busy hours included.',
  },
  {
    icon: '✅',
    title: 'Answers only from your information',
    text: 'The AI replies using what you have actually provided in your Knowledge Base. It never invents details about your products, pricing, or policies.',
  },
  {
    icon: '🎛️',
    title: 'You stay in full control',
    text: 'Any conversation can be taken over manually at any time, and the AI can be paused or resumed per conversation with one click.',
  },
]

export default function LandingPage({ onSignIn }) {
  // Show a session-checking spinner only until we know for sure there is no
  // usable session, so a logged-in user who lands on "/" goes straight to the
  // dashboard instead of seeing the marketing page.
  const [checking, setChecking] = useState(Boolean(isSupabaseConfigured && supabase))

  useEffect(() => {
    if (!supabase) return undefined
    let cancelled = false
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled && session) onSignIn()
    }).catch(() => { /* ignore — treated as logged out */ }).finally(() => {
      if (!cancelled) setChecking(false)
    })
    return () => { cancelled = true }
  }, [onSignIn])

  if (checking) {
    return (
      <div className="landing-page" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div className="landing-spinner" aria-label="Loading" />
      </div>
    )
  }

  return (
    <div className="landing-page">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="landing-header">
        <div className="landing-header-inner">
          <div className="landing-brand">
            <LandingLogo />
            <span>WhatsApp Business Assistant</span>
          </div>
          <nav className="landing-header-nav" aria-label="Page sections">
            <button type="button" onClick={scrollToSection('how-it-works')}>How it works</button>
            <button type="button" onClick={scrollToSection('features')}>Features</button>
            <button type="button" onClick={scrollToSection('why-ai')}>Why AI replies</button>
          </nav>
          <button type="button" className="landing-btn-primary" onClick={onSignIn}>Sign In</button>
        </div>
      </header>

      <main>
        {/* ── 1. Hero ────────────────────────────────────────────────── */}
        <section className="landing-hero">
          <span className="landing-eyebrow">AI-powered WhatsApp business automation</span>
          <h1>
            Automate your WhatsApp customer conversations — <em>without losing the personal touch</em>
          </h1>
          <p className="landing-sub">
            Connect your WhatsApp, let AI auto-reply to customers using your own business knowledge,
            and run bulk outreach campaigns — all from one dashboard.
          </p>
          <div className="landing-cta-row">
            <button type="button" className="landing-btn-primary landing-btn-lg" onClick={onSignIn}>Get Started</button>
            <button type="button" className="landing-btn-secondary landing-btn-lg" onClick={scrollToSection('how-it-works')}>See how it works</button>
          </div>
          <ul className="landing-hero-points">
            <li>No coding required</li>
            <li>Works with your existing number</li>
            <li>Take over any conversation manually</li>
          </ul>
        </section>

        {/* ── 2. How it works ────────────────────────────────────────── */}
        <section id="how-it-works" className="landing-section">
          <span className="landing-eyebrow">How it works</span>
          <h2>Up and running in four steps</h2>
          <p className="landing-section-sub">From connecting your number to your first campaign — no technical setup needed.</p>
          <ol className="landing-steps">
            {HOW_IT_WORKS_STEPS.map((step, index) => (
              <li className="landing-step-card" key={step.title}>
                <span className="landing-step-number">{index + 1}</span>
                <span className="landing-step-icon" aria-hidden="true">{step.icon}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── 3. Feature grid ────────────────────────────────────────── */}
        <section id="features" className="landing-section landing-section-alt">
          <span className="landing-eyebrow">Features</span>
          <h2>Everything your business needs on WhatsApp</h2>
          <p className="landing-section-sub">One dashboard for customer conversations, outreach, and insights.</p>
          <div className="landing-feature-grid">
            {FEATURES.map((feature) => (
              <article className="landing-feature-card" key={feature.title}>
                <span className="landing-feature-icon" aria-hidden="true">{feature.icon}</span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── 4. Why AI Auto-Reply matters ───────────────────────────── */}
        <section id="why-ai" className="landing-section">
          <span className="landing-eyebrow">Why AI Auto-Reply matters</span>
          <h2>Every customer gets an instant answer — on your terms</h2>
          <p className="landing-section-sub">
            Missed messages are missed business. Auto-reply keeps every conversation moving while you keep full control.
          </p>
          <div className="landing-why-grid">
            {WHY_POINTS.map((point) => (
              <article className="landing-why-card" key={point.title}>
                <span className="landing-why-icon" aria-hidden="true">{point.icon}</span>
                <div>
                  <h3>{point.title}</h3>
                  <p>{point.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ── 5. Closing CTA ─────────────────────────────────────────── */}
        <section className="landing-cta-panel">
          <h2>Ready to put your WhatsApp on autopilot?</h2>
          <p>Connect your number, add your knowledge, and let the AI handle the first reply — free to set up in minutes.</p>
          <div className="landing-cta-row">
            <button type="button" className="landing-btn-primary landing-btn-lg" onClick={onSignIn}>Get Started</button>
            <button type="button" className="landing-btn-secondary landing-btn-lg" onClick={onSignIn}>Sign In</button>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} WhatsApp Business Assistant. All rights reserved.</span>
      </footer>
    </div>
  )
}
