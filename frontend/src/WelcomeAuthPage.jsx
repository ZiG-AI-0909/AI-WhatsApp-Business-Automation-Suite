import React, { useState } from 'react';
import { supabase, isSupabaseConfigured } from './supabaseClient';

export default function WelcomeAuthPage({ onAuthSuccess }) {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage({ type: '', text: '' });

    if (!isSupabaseConfigured || !supabase) {
      setMessage({
        type: 'error',
        text: 'Supabase credentials are not configured in your environment. Please check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      });
      return;
    }

    if (!email.trim()) {
      setMessage({ type: 'error', text: 'Please enter a valid email address.' });
      return;
    }

    if (mode === 'forgot') {
      setLoading(true);
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
        if (error) throw error;
        setMessage({
          type: 'success',
          text: 'Password reset link sent to your email. Please check your inbox.',
        });
      } catch (err) {
        setMessage({ type: 'error', text: err.message || 'Failed to send reset email.' });
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!password) {
      setMessage({ type: 'error', text: 'Please enter your password.' });
      return;
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        setMessage({ type: 'error', text: 'Password must be at least 6 characters long.' });
        return;
      }
      if (password !== confirmPassword) {
        setMessage({ type: 'error', text: 'Passwords do not match.' });
        return;
      }

      setLoading(true);
      try {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: fullName.trim() },
          },
        });

        if (error) throw error;

        if (data?.session) {
          setMessage({ type: 'success', text: 'Account created! Entering dashboard...' });
          onAuthSuccess(data.session);
        } else if (data?.user) {
          setMessage({
            type: 'success',
            text: 'Account registered! Please check your email to verify your address before signing in.',
          });
          setMode('signin');
        }
      } catch (err) {
        setMessage({ type: 'error', text: err.message || 'Failed to create account.' });
      } finally {
        setLoading(false);
      }
    } else {
      // Sign In
      setLoading(true);
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (error) throw error;

        if (data?.session) {
          setMessage({ type: 'success', text: 'Signed in successfully! Entering dashboard...' });
          onAuthSuccess(data.session);
        }
      } catch (err) {
        setMessage({ type: 'error', text: err.message || 'Invalid email or password.' });
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8 relative overflow-hidden font-sans">
      {/* Background ambient lighting effects */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-cyan-500/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 -right-40 w-96 h-96 bg-indigo-500/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 left-1/3 w-96 h-96 bg-teal-500/15 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-6xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 items-center relative z-10">
        {/* Left / Feature Highlight Column */}
        <div className="lg:col-span-7 space-y-8 pr-0 lg:pr-6">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-950/80 border border-cyan-800/60 text-cyan-300 text-xs font-semibold tracking-wide uppercase shadow-inner">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            Bhavesh's AI Sales Suite
          </div>

          <div className="space-y-4">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-white leading-tight">
              Scale Your Sales on <br className="hidden sm:inline" />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-teal-300 to-indigo-400">
                WhatsApp with AI
              </span>
            </h1>
            <p className="text-lg text-slate-400 max-w-xl leading-relaxed">
              Automate customer support, capture leads straight from catalog photos, broadcast personalized campaigns, and close deals effortlessly 24/7.
            </p>
          </div>

          {/* Feature highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 hover:border-cyan-500/40 transition-colors">
              <div className="text-2xl mb-2">⚡</div>
              <h3 className="font-semibold text-white text-base">24/7 AI Smart Agent</h3>
              <p className="text-xs text-slate-400 mt-1">Autonomous contextual chat replies, intent detection, and seamless human agent handoff.</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 hover:border-cyan-500/40 transition-colors">
              <div className="text-2xl mb-2">📸</div>
              <h3 className="font-semibold text-white text-base">Vision Lead Extractor</h3>
              <p className="text-xs text-slate-400 mt-1">Extract business cards, phone numbers, and directory listings with NVIDIA Vision OCR.</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 hover:border-cyan-500/40 transition-colors">
              <div className="text-2xl mb-2">🚀</div>
              <h3 className="font-semibold text-white text-base">Targeted Broadcasts</h3>
              <p className="text-xs text-slate-400 mt-1">Excel-backed campaign messaging with scheduled pacing and deliverability safeguards.</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 hover:border-cyan-500/40 transition-colors">
              <div className="text-2xl mb-2">🔒</div>
              <h3 className="font-semibold text-white text-base">Enterprise Security</h3>
              <p className="text-xs text-slate-400 mt-1">Protected by Supabase Auth with encrypted sessions and Row Level Security.</p>
            </div>
          </div>

          <div className="flex items-center gap-6 pt-2 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 font-bold">✓</span> Zero setup friction
            </div>
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 font-bold">✓</span> Real-time analytics
            </div>
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 font-bold">✓</span> Direct WhatsApp Baileys sync
            </div>
          </div>
        </div>

        {/* Right / Auth Form Column */}
        <div className="lg:col-span-5">
          <div className="bg-slate-900/90 backdrop-blur-xl border border-slate-800 rounded-3xl p-8 shadow-2xl shadow-cyan-950/20">
            {/* Tab switch */}
            <div className="flex rounded-xl bg-slate-950/80 p-1 border border-slate-800 mb-6">
              <button
                type="button"
                className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                  mode === 'signin'
                    ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
                onClick={() => {
                  setMode('signin');
                  setMessage({ type: '', text: '' });
                }}
              >
                Sign In
              </button>
              <button
                type="button"
                className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                  mode === 'signup'
                    ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
                onClick={() => {
                  setMode('signup');
                  setMessage({ type: '', text: '' });
                }}
              >
                Create Account
              </button>
            </div>

            {/* Header info */}
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white tracking-tight">
                {mode === 'signup'
                  ? 'Get started in seconds'
                  : mode === 'forgot'
                  ? 'Reset your password'
                  : 'Welcome back'}
              </h2>
              <p className="text-sm text-slate-400 mt-1">
                {mode === 'signup'
                  ? 'Create your account to access the AI sales dashboard.'
                  : mode === 'forgot'
                  ? 'Enter your account email to receive a recovery link.'
                  : 'Enter your credentials to manage your WhatsApp suite.'}
              </p>
            </div>

            {/* Feedback alert message */}
            {message.text && (
              <div
                className={`p-3.5 rounded-xl text-sm mb-5 flex items-start gap-2.5 ${
                  message.type === 'error'
                    ? 'bg-red-950/60 border border-red-800/80 text-red-300'
                    : 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                }`}
              >
                <span className="text-base leading-none">
                  {message.type === 'error' ? '⚠️' : '✅'}
                </span>
                <div className="flex-1 leading-snug">{message.text}</div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'signup' && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                    Full Name / Organization
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Bhavesh Sharma"
                    className="w-full px-4 py-2.5 rounded-xl bg-slate-950/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent transition-all text-sm"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-950/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent transition-all text-sm"
                />
              </div>

              {mode !== 'forgot' && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Password
                    </label>
                    {mode === 'signin' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot');
                          setMessage({ type: '', text: '' });
                        }}
                        className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full px-4 py-2.5 rounded-xl bg-slate-950/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent transition-all text-sm pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-xs px-1 py-0.5"
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              )}

              {mode === 'signup' && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                    Confirm Password
                  </label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-4 py-2.5 rounded-xl bg-slate-950/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent transition-all text-sm"
                  />
                </div>
              )}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 shadow-lg shadow-cyan-500/25 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading && (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  {loading
                    ? 'Processing...'
                    : mode === 'signup'
                    ? 'Create Account'
                    : mode === 'forgot'
                    ? 'Send Password Reset Link'
                    : 'Sign In to Dashboard'}
                </button>
              </div>

              {mode === 'forgot' && (
                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signin');
                      setMessage({ type: '', text: '' });
                    }}
                    className="text-xs text-slate-400 hover:text-cyan-400 transition-colors"
                  >
                    ← Back to Sign In
                  </button>
                </div>
              )}
            </form>

            <div className="mt-6 pt-5 border-t border-slate-800 text-center text-xs text-slate-500">
              Secured by <span className="font-semibold text-slate-400">Supabase Authentication</span> with 256-bit encryption.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
