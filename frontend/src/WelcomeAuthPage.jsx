import React, { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from './supabaseClient';

// ─── Password strength helper ──────────────────────────────────────────────────
function getPasswordStrength(pw) {
  if (!pw) return { level: 0, label: '', color: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { level: 1, label: 'Weak', color: '#ef4444' };
  if (score <= 3) return { level: 2, label: 'Fair', color: '#f59e0b' };
  return { level: 3, label: 'Strong', color: '#10b981' };
}

// ─── Eye toggle icons ──────────────────────────────────────────────────────────
function EyeIcon({ open }) {
  return open ? (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}

// ─── Google "G" logo SVG ────────────────────────────────────────────────────────
function GoogleLogo() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285F4" d="M47.5 24.55c0-1.64-.15-3.23-.42-4.75H24v9.01h13.16c-.57 3.06-2.28 5.65-4.86 7.38v6.13h7.87C44.27 38.03 47.5 31.82 47.5 24.55z" />
      <path fill="#34A853" d="M24 48c6.61 0 12.16-2.19 16.21-5.93l-7.87-6.13C30.2 37.51 27.27 38.4 24 38.4c-6.38 0-11.79-4.31-13.72-10.1H2.16v6.34C6.19 43.29 14.5 48 24 48z" />
      <path fill="#FBBC05" d="M10.28 28.3A14.52 14.52 0 0 1 9.6 24c0-1.49.25-2.94.68-4.3v-6.34H2.16A23.99 23.99 0 0 0 0 24c0 3.87.92 7.53 2.16 10.64l8.12-6.34z" />
      <path fill="#EA4335" d="M24 9.6c3.6 0 6.83 1.24 9.37 3.67l7.01-7.01C36.15 2.19 30.6 0 24 0 14.5 0 6.19 4.71 2.16 13.36l8.12 6.34C12.21 13.91 17.62 9.6 24 9.6z" />
    </svg>
  );
}

// ─── Reusable notification banner ─────────────────────────────────────────────
function Notice({ type, text, onDismiss }) {
  if (!text) return null;
  const isError = type === 'error';
  return (
    <div className={`mb-5 p-3.5 rounded-xl text-sm flex items-start gap-3 border ${isError
      ? 'bg-red-950/50 border-red-800/60 text-red-200'
      : 'bg-emerald-950/50 border-emerald-800/60 text-emerald-200'
      }`}>
      <span className="flex-shrink-0 mt-0.5">{isError ? '⚠️' : '✅'}</span>
      <span className="flex-1 text-xs sm:text-sm leading-relaxed">{text}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="flex-shrink-0 text-slate-400 hover:text-slate-200 transition-colors" aria-label="Dismiss">✕</button>
      )}
    </div>
  );
}

// ─── PasswordField with toggle ─────────────────────────────────────────────────
function PasswordField({ id, label, value, onChange, autoComplete, error, showStrength, action }) {
  const [show, setShow] = useState(false);
  const strength = showStrength ? getPasswordStrength(value) : null;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={id} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
          {label}
        </label>
        {action}
      </div>
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          placeholder="••••••••"
          className={`w-full pl-10 pr-11 py-2.5 rounded-xl bg-slate-950/80 border text-white text-sm
            placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${error ? 'border-red-500 focus:border-red-500' : 'border-slate-800 focus:border-emerald-500'
            }`}
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-200 transition-colors focus:outline-none"
          aria-label={show ? 'Hide password' : 'Show password'}
        >
          <EyeIcon open={show} />
        </button>
      </div>
      {showStrength && value && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex gap-1 flex-1">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-1 flex-1 rounded-full transition-all duration-300"
                style={{ backgroundColor: i <= strength.level ? strength.color : '#1e293b' }} />
            ))}
          </div>
          <span className="text-[11px] font-medium" style={{ color: strength.color }}>{strength.label}</span>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

// ─── Google OAuth button ────────────────────────────────────────────────────────
function GoogleButton({ loading, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-xl bg-white/5
        border border-slate-700/60 hover:bg-white/10 hover:border-slate-600 transition-all
        text-sm font-medium text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? (
        <span className="w-4 h-4 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin" />
      ) : (
        <GoogleLogo />
      )}
      {loading ? 'Redirecting to Google…' : label}
    </button>
  );
}

// ─── Divider ──────────────────────────────────────────────────────────────────
function Divider() {
  return (
    <div className="relative my-5">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-slate-800" />
      </div>
      <div className="relative flex justify-center text-xs uppercase tracking-wider">
        <span className="bg-[#0D1322] px-3 text-slate-500 font-semibold">or</span>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
// Modes: 'signin' | 'signup' | 'forgot' | 'verify-email' | 'reset-password'
export default function WelcomeAuthPage({ onAuthSuccess, initialMode }) {
  const [mode, setMode] = useState(initialMode || 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState({ type: '', text: '' });
  const [verifyEmail, setVerifyEmail] = useState('');   // email shown on verify screen
  const [resendCooldown, setResendCooldown] = useState(0);

  // Respect initialMode prop changes (e.g., PASSWORD_RECOVERY from App.jsx)
  useEffect(() => {
    if (initialMode) setMode(initialMode);
  }, [initialMode]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const clearNotice = () => setNotice({ type: '', text: '' });
  const switchMode = (next) => { setMode(next); setErrors({}); clearNotice(); };
  const err = (field) => errors[field] && <p className="mt-1 text-xs text-red-400">{errors[field]}</p>;

  const validate = (forMode = mode) => {
    const e = {};
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email.trim()) e.email = 'Email address is required.';
    else if (!emailRe.test(email.trim())) e.email = 'Please enter a valid email address.';

    if (forMode === 'signup') {
      if (!fullName.trim()) e.fullName = 'Full name is required.';
      if (!password) e.password = 'Password is required.';
      else if (password.length < 8) e.password = 'Password must be at least 8 characters.';
      if (password !== confirmPassword) e.confirmPassword = 'Passwords do not match.';
      if (!termsAccepted) e.terms = 'You must accept the Terms of Service to continue.';
    }
    if (forMode === 'signin') {
      if (!password) e.password = 'Password is required.';
    }
    if (forMode === 'reset-password') {
      if (!password) e.password = 'New password is required.';
      else if (password.length < 8) e.password = 'Password must be at least 8 characters.';
      if (password !== confirmPassword) e.confirmPassword = 'Passwords do not match.';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const supabaseRequired = () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        type: 'error',
        text: 'Authentication service is not configured. Please check your environment variables.',
      });
      return false;
    }
    return true;
  };

  // ── Google OAuth ────────────────────────────────────────────────────────────
  const handleGoogleAuth = async () => {
    if (!supabaseRequired()) return;
    setGoogleLoading(true);
    clearNotice();
    try {
      // Must include /auth/callback path so Supabase redirects back to the app
      // after the OAuth provider grants access. Works on localhost, Vercel preview, and production.
      const redirectTo = `${window.location.origin}/auth/callback`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
        },
      });
      if (error) throw error;
      // Browser will redirect — no further action needed here.
    } catch (err) {
      setGoogleLoading(false);
      setNotice({ type: 'error', text: err.message || 'Google sign-in failed. Please try again.' });
    }
  };

  // ── Email/Password form ─────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    clearNotice();
    if (!validate()) return;
    if (!supabaseRequired()) return;
    setLoading(true);

    try {
      // ── Sign Up ────────────────────────────────────────────────────────────
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() } },
        });
        if (error) throw error;

        if (data?.session) {
          // Email confirmation disabled — session granted immediately
          setNotice({ type: 'success', text: 'Account created! Launching your dashboard…' });
          setTimeout(() => onAuthSuccess(data.session), 500);
        } else {
          // Email confirmation enabled — show verification screen
          setVerifyEmail(email.trim());
          switchMode('verify-email');
        }
        return;
      }

      // ── Sign In ────────────────────────────────────────────────────────────
      if (mode === 'signin') {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) {
          // Never expose internal Supabase error details to the user
          throw new Error('Email or password is incorrect. Please try again.');
        }
        if (data?.session) {
          setNotice({ type: 'success', text: 'Welcome back! Launching your suite…' });
          setTimeout(() => onAuthSuccess(data.session), 400);
        }
        return;
      }

      // ── Forgot Password ────────────────────────────────────────────────────
      if (mode === 'forgot') {
        const redirectTo = `${window.location.origin}/auth/callback`;
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        if (error) throw error;
        setNotice({
          type: 'success',
          text: 'Password reset instructions have been sent. Please check your inbox (and spam folder).',
        });
        setResendCooldown(60);
        return;
      }

      // ── Reset Password ─────────────────────────────────────────────────────
      if (mode === 'reset-password') {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          // Handle expired/invalid recovery link
          if (error.message?.toLowerCase().includes('expired') ||
            error.message?.toLowerCase().includes('invalid')) {
            throw new Error('This password reset link has expired or is invalid. Please request a new one.');
          }
          throw error;
        }
        setNotice({ type: 'success', text: 'Password updated successfully! Please sign in with your new password.' });
        setTimeout(() => switchMode('signin'), 2000);
        return;
      }
    } catch (err) {
      setNotice({ type: 'error', text: err.message || 'Something went wrong. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  // ── Resend verification email ───────────────────────────────────────────────
  const handleResendVerification = async () => {
    if (!supabase || resendCooldown > 0) return;
    setLoading(true);
    clearNotice();
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: verifyEmail || email.trim(),
      });
      if (error) throw error;
      setNotice({ type: 'success', text: 'Verification email resent. Please check your inbox.' });
      setResendCooldown(60);
    } catch (err) {
      setNotice({ type: 'error', text: err.message || 'Failed to resend. Please try again shortly.' });
    } finally {
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-[#080C15] text-slate-100 flex items-center justify-center p-4 sm:p-6 lg:p-12 relative overflow-hidden font-sans selection:bg-emerald-500 selection:text-white">
      {/* Background decorations */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b10_1px,transparent_1px),linear-gradient(to_bottom,#1e293b10_1px,transparent_1px)] bg-[size:3.5rem_3.5rem] pointer-events-none" />
      <div className="absolute -top-48 left-1/4 w-96 h-96 bg-emerald-500/15 rounded-full blur-[128px] pointer-events-none" />
      <div className="absolute top-1/2 -right-48 w-96 h-96 bg-cyan-500/15 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute -bottom-48 left-10 w-96 h-96 bg-indigo-500/10 rounded-full blur-[140px] pointer-events-none" />

      <div className="max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-14 items-center relative z-10 my-auto">

        {/* ═══════════════════════════════════════════════════════════
            LEFT COLUMN — brand & feature showcase
            ═══════════════════════════════════════════════════════════ */}
        <div className="lg:col-span-7 flex flex-col justify-center space-y-8 order-2 lg:order-1 pt-4 lg:pt-0">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 via-teal-400 to-cyan-500 p-0.5 shadow-lg shadow-emerald-500/20 flex items-center justify-center">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </div>
            </div>
            <div>
              <span className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                Sudarshan Pipes AI Assistant
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  v2.0 PRO
                </span>
              </span>
            </div>
          </div>

          {/* Headline */}
          <div className="space-y-4">
            <h1 className="text-4xl sm:text-5xl xl:text-6xl font-extrabold tracking-tight text-white leading-[1.12]">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-cyan-200 to-white drop-shadow-[0_0_18px_rgba(52,211,153,0.35)]">
                Scale Your Sales
              </span>{" "}
              on <br />

              <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-white to-cyan-400">
                WhatsApp with AI
              </span>
            </h1>

            <p className="text-base sm:text-lg text-slate-400 max-w-xl font-normal leading-relaxed">
              Automate customer support, capture leads, launch personalized campaigns,
              and close deals effortlessly 24/7.
            </p>
          </div>

          {/* Live chat demo card */}
          <div className="relative rounded-2xl bg-gradient-to-b from-slate-900/90 to-slate-950/90 border border-slate-800/80 p-5 shadow-2xl backdrop-blur-md max-w-xl">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-4">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </span>
                <span className="text-xs font-semibold text-slate-200">AI Assistant • Live WhatsApp Session</span>
              </div>
              <span className="text-[11px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                Avg Response: 1.2s
              </span>
            </div>
            <div className="space-y-3 text-xs">
              <div className="flex items-start gap-2 max-w-[85%]">
                <div className="w-6 h-6 rounded-full bg-slate-800 flex-shrink-0 flex items-center justify-center text-[10px] text-slate-300 font-bold">C</div>
                <div className="bg-slate-800/90 text-slate-200 p-2.5 rounded-2xl rounded-tl-sm border border-slate-700/60 leading-relaxed shadow-sm">
                  Hello, I need 500 meters of 2-inch PVC pressure pipes. Can you deliver by Thursday?
                </div>
              </div>
              <div className="flex items-start gap-2 max-w-[90%] ml-auto flex-row-reverse">
                <div className="w-6 h-6 rounded-full bg-emerald-600 flex-shrink-0 flex items-center justify-center text-[10px] text-white font-bold shadow-md shadow-emerald-500/20">⚡</div>
                <div className="bg-emerald-950/80 text-emerald-100 p-2.5 rounded-2xl rounded-tr-sm border border-emerald-500/30 leading-relaxed shadow-md">
                  Hello! Yes, standard 2-inch Class 3 PVC pipes are in stock. We can guarantee delivery by Thursday. I've prepared your pro-forma quote. Shall I send it right here?
                  <div className="flex items-center justify-between text-[10px] text-emerald-400/80 mt-1.5 pt-1 border-t border-emerald-800/40">
                    <span>AI Auto-Qualified ✓</span>
                    <span>10:42 AM</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Feature grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
            {[
              { icon: '⚡', color: 'emerald', title: '24/7 AI Smart Agent', desc: 'Autonomous conversations, intent detection, and seamless human handoff.' },
              { icon: '👁', color: 'cyan', title: 'Vision Lead Extractor', desc: 'Extract business cards, phone numbers, and directory listings using AI-powered vision.' },
              { icon: '📢', color: 'teal', title: 'Targeted Broadcasts', desc: 'Launch personalized WhatsApp campaigns with scheduling and delivery safeguards.' },
              { icon: '🔐', color: 'indigo', title: 'Enterprise Security', desc: 'Protected by Supabase authentication, encrypted sessions, and Row Level Security.' },
            ].map(f => (
              <div key={f.title} className={`p-4 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-${f.color}-500/40 transition-all group`}>
                <div className={`flex items-center gap-2.5 text-${f.color}-400 mb-1.5`}>
                  <span className="text-base">{f.icon}</span>
                  <h3 className="font-semibold text-slate-200 text-sm group-hover:text-white transition-colors">{f.title}</h3>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            RIGHT COLUMN — auth card
            ═══════════════════════════════════════════════════════════ */}
        <div className="lg:col-span-5 order-1 lg:order-2">
          <div className="w-full bg-[#0D1322]/90 backdrop-blur-2xl border border-slate-800/90 rounded-3xl p-6 sm:p-9 shadow-2xl shadow-black/60 relative">
            {/* Top glow accent */}
            <div className="absolute -top-[1px] left-1/4 right-1/4 h-[2px] bg-gradient-to-r from-transparent via-emerald-400/70 to-transparent" />

            <Notice type={notice.type} text={notice.text} onDismiss={clearNotice} />

            {/* ── EMAIL VERIFICATION SCREEN ── */}
            {mode === 'verify-email' && (
              <div className="text-center space-y-5">
                <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                  <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-white mb-2">Check your email</h2>
                  <p className="text-sm text-slate-400 leading-relaxed">
                    We sent a verification link to{' '}
                    <strong className="text-slate-200 font-semibold">{verifyEmail || 'your email address'}</strong>.
                    Click the link in the email to activate your account.
                  </p>
                </div>
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 text-xs text-slate-400 text-left space-y-1">
                  <p>📬 Check your <strong className="text-slate-300">spam or junk folder</strong> if you don't see it within 2 minutes.</p>
                  <p>🔗 The link expires after <strong className="text-slate-300">24 hours</strong>.</p>
                </div>
                <div className="space-y-3 pt-1">
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={loading || resendCooldown > 0}
                    className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-white shadow-lg shadow-emerald-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? 'Sending…' : resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend verification email'}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode('signup')}
                    className="w-full text-xs text-slate-400 hover:text-emerald-400 transition-colors py-1"
                  >
                    ← Change email / return to sign up
                  </button>
                </div>
              </div>
            )}

            {/* ── RESET PASSWORD SCREEN ── */}
            {mode === 'reset-password' && (
              <>
                <div className="mb-6">
                  <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">Set new password</h2>
                  <p className="text-sm text-slate-400 mt-1.5">Choose a strong password for your account.</p>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                  <PasswordField
                    id="new-password"
                    label="New Password"
                    value={password}
                    onChange={e => { setPassword(e.target.value); setErrors(p => ({ ...p, password: null })) }}
                    autoComplete="new-password"
                    error={errors.password}
                    showStrength
                  />
                  <PasswordField
                    id="confirm-new-password"
                    label="Confirm New Password"
                    value={confirmPassword}
                    onChange={e => { setConfirmPassword(e.target.value); setErrors(p => ({ ...p, confirmPassword: null })) }}
                    autoComplete="new-password"
                    error={errors.confirmPassword}
                  />
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-3 px-4 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 shadow-lg shadow-emerald-500/25 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                      {loading ? 'Updating…' : 'Update Password'}
                    </button>
                  </div>
                </form>
              </>
            )}

            {/* ── SIGN IN / SIGN UP / FORGOT ── */}
            {(mode === 'signin' || mode === 'signup' || mode === 'forgot') && (
              <>
                {/* Card header */}
                <div className="mb-6">
                  <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                    {mode === 'signin' && 'Welcome back'}
                    {mode === 'signup' && 'Create your account'}
                    {mode === 'forgot' && 'Reset your password'}
                  </h2>
                  <p className="text-sm text-slate-400 mt-1.5">
                    {mode === 'signin' && 'Sign in to continue to your AI Sales Suite.'}
                    {mode === 'signup' && 'Start building your WhatsApp sales engine with AI.'}
                    {mode === 'forgot' && 'Enter your email to receive a password reset link.'}
                  </p>
                </div>

                {/* Google OAuth — shown on signin and signup */}
                {mode !== 'forgot' && (
                  <>
                    <GoogleButton
                      loading={googleLoading}
                      onClick={handleGoogleAuth}
                      label={mode === 'signup' ? 'Continue with Google' : 'Sign in with Google'}
                    />
                    <Divider />
                  </>
                )}

                {/* Email/Password form */}
                <form onSubmit={handleSubmit} className="space-y-4" noValidate>

                  {/* Full name — signup only */}
                  {mode === 'signup' && (
                    <div>
                      <label htmlFor="full-name" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                        Full Name
                      </label>
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                        </div>
                        <input
                          id="full-name"
                          type="text"
                          autoComplete="name"
                          value={fullName}
                          onChange={e => { setFullName(e.target.value); setErrors(p => ({ ...p, fullName: null })) }}
                          placeholder="Your full name"
                          className={`w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950/80 border text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${errors.fullName ? 'border-red-500' : 'border-slate-800 focus:border-emerald-500'}`}
                        />
                      </div>
                      {err('fullName')}
                    </div>
                  )}

                  {/* Email */}
                  <div>
                    <label htmlFor="email" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                      Email Address
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <input
                        id="email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={e => { setEmail(e.target.value); setErrors(p => ({ ...p, email: null })) }}
                        placeholder="name@company.com"
                        className={`w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950/80 border text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${errors.email ? 'border-red-500' : 'border-slate-800 focus:border-emerald-500'}`}
                      />
                    </div>
                    {err('email')}
                  </div>

                  {/* Password — not shown on forgot */}
                  {mode !== 'forgot' && (
                    <PasswordField
                      id="password"
                      label="Password"
                      value={password}
                      onChange={e => { setPassword(e.target.value); setErrors(p => ({ ...p, password: null })) }}
                      autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                      error={errors.password}
                      showStrength={mode === 'signup'}
                      action={mode === 'signin' && (
                        <button type="button" onClick={() => switchMode('forgot')} className="text-xs text-emerald-400 hover:text-emerald-300 hover:underline transition-colors focus:outline-none">
                          Forgot password?
                        </button>
                      )}
                    />
                  )}

                  {/* Confirm password — signup only */}
                  {mode === 'signup' && (
                    <PasswordField
                      id="confirm-password"
                      label="Confirm Password"
                      value={confirmPassword}
                      onChange={e => { setConfirmPassword(e.target.value); setErrors(p => ({ ...p, confirmPassword: null })) }}
                      autoComplete="new-password"
                      error={errors.confirmPassword}
                    />
                  )}

                  {/* Terms — signup only */}
                  {mode === 'signup' && (
                    <div>
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={termsAccepted}
                          onChange={e => { setTermsAccepted(e.target.checked); setErrors(p => ({ ...p, terms: null })) }}
                          className="mt-0.5 w-4 h-4 rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500/50 focus:ring-2 flex-shrink-0"
                        />
                        <span className="text-xs text-slate-400 leading-relaxed">
                          I agree to the{' '}
                          <span className="text-emerald-400 hover:underline cursor-pointer">Terms of Service</span>
                          {' '}and{' '}
                          <span className="text-emerald-400 hover:underline cursor-pointer">Privacy Policy</span>.
                        </span>
                      </label>
                      {err('terms')}
                    </div>
                  )}

                  {/* Submit */}
                  <div className="pt-1">
                    <button
                      type="submit"
                      disabled={loading || googleLoading}
                      className="w-full py-3 px-4 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 shadow-lg shadow-emerald-500/25 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                      {loading
                        ? 'Authenticating…'
                        : mode === 'signup'
                          ? 'Create Account'
                          : mode === 'forgot'
                            ? 'Send Reset Link'
                            : 'Sign In'}
                    </button>
                  </div>

                  {/* Forgot: back to sign in + resend */}
                  {mode === 'forgot' && (
                    <div className="text-center space-y-2 pt-1">
                      {resendCooldown > 0 && (
                        <p className="text-xs text-slate-500">You can resend in {resendCooldown}s.</p>
                      )}
                      <button type="button" onClick={() => switchMode('signin')} className="text-xs text-slate-400 hover:text-emerald-400 transition-colors">
                        ← Back to Sign In
                      </button>
                    </div>
                  )}
                </form>

                {/* Mode switcher */}
                {mode !== 'forgot' && (
                  <div className="mt-5 text-center text-xs text-slate-400">
                    {mode === 'signin' ? (
                      <>
                        Don't have an account?{' '}
                        <button type="button" onClick={() => switchMode('signup')} className="font-semibold text-emerald-400 hover:text-emerald-300 hover:underline transition-colors focus:outline-none">
                          Create account
                        </button>
                      </>
                    ) : (
                      <>
                        Already have an account?{' '}
                        <button type="button" onClick={() => switchMode('signin')} className="font-semibold text-emerald-400 hover:text-emerald-300 hover:underline transition-colors focus:outline-none">
                          Sign in
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Card footer */}
            <div className="mt-8 pt-5 border-t border-slate-800/80 flex items-center justify-center gap-2 text-[11px] text-slate-500">
              <svg className="w-3.5 h-3.5 text-emerald-400/80" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              <span>Secured by Supabase Auth · End-to-End Encrypted Sessions</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
