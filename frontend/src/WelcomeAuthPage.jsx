import React, { useState } from 'react';
import { supabase, isSupabaseConfigured } from './supabaseClient';

export default function WelcomeAuthPage({ onAuthSuccess }) {
  // Modes: 'signin' | 'signup' | 'forgot'
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // Field errors for inline validation
  const [errors, setErrors] = useState({});
  // General banner notification
  const [notification, setNotification] = useState({ type: '', text: '' });

  const validate = () => {
    const nextErrors = {};
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!email.trim()) {
      nextErrors.email = 'Email address is required.';
    } else if (!emailRegex.test(email.trim())) {
      nextErrors.email = 'Please enter a valid email address.';
    }

    if (mode !== 'forgot') {
      if (!password) {
        nextErrors.password = 'Password is required.';
      } else if (mode === 'signup' && password.length < 8) {
        nextErrors.password = 'Password must contain at least 8 characters.';
      }
    }

    if (mode === 'signup') {
      if (!fullName.trim()) {
        nextErrors.fullName = 'Full name is required.';
      }
      if (password !== confirmPassword) {
        nextErrors.confirmPassword = 'Passwords do not match.';
      }
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setNotification({ type: '', text: '' });

    if (!validate()) return;

    if (!isSupabaseConfigured || !supabase) {
      setNotification({
        type: 'error',
        text: 'Supabase is not configured yet. Please check your environment variables (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).',
      });
      return;
    }

    setLoading(true);

    try {
      if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
        if (error) throw error;
        setNotification({
          type: 'success',
          text: 'Password recovery instructions have been sent to your email.',
        });
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: fullName.trim() },
          },
        });

        if (error) throw error;

        if (data?.session) {
          setNotification({ type: 'success', text: 'Account created! Redirecting to dashboard...' });
          setTimeout(() => onAuthSuccess(data.session), 500);
        } else {
          setNotification({
            type: 'success',
            text: 'Account created. Please check your email to verify your account.',
          });
          setMode('signin');
          setPassword('');
          setConfirmPassword('');
        }
      } else {
        // Sign In
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (error) {
          throw new Error('Email or password is incorrect.');
        }

        if (data?.session) {
          setNotification({ type: 'success', text: 'Welcome back! Launching your suite...' });
          setTimeout(() => onAuthSuccess(data.session), 400);
        }
      }
    } catch (err) {
      setNotification({
        type: 'error',
        text: err.message || 'Authentication failed. Please try again.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#080C15] text-slate-100 flex items-center justify-center p-4 sm:p-6 lg:p-12 relative overflow-hidden font-sans selection:bg-emerald-500 selection:text-white">
      {/* Background Gradients & Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b10_1px,transparent_1px),linear-gradient(to_bottom,#1e293b10_1px,transparent_1px)] bg-[size:3.5rem_3.5rem] pointer-events-none" />
      <div className="absolute -top-48 left-1/4 w-96 h-96 bg-emerald-500/15 rounded-full blur-[128px] pointer-events-none" />
      <div className="absolute top-1/2 -right-48 w-96 h-96 bg-cyan-500/15 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute -bottom-48 left-10 w-96 h-96 bg-indigo-500/10 rounded-full blur-[140px] pointer-events-none" />

      {/* Main Container */}
      <div className="max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-14 items-center relative z-10 my-auto">
        
        {/* =========================================================================
            LEFT COLUMN: Marketing, Brand Showcase & AI Engine Preview
            ========================================================================= */}
        <div className="lg:col-span-7 flex flex-col justify-center space-y-8 order-2 lg:order-1 pt-4 lg:pt-0">
          
          {/* Logo / Brand Header */}
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
                Bhavesh's AI Sales Suite
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  v2.0 PRO
                </span>
              </span>
            </div>
          </div>

          {/* Headline & Value Proposition */}
          <div className="space-y-4">
            <h1 className="text-4xl sm:text-5xl xl:text-6xl font-extrabold tracking-tight text-white leading-[1.12]">
              Scale Your Sales on <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400">
                WhatsApp with AI
              </span>
            </h1>
            <p className="text-base sm:text-lg text-slate-400 max-w-xl font-normal leading-relaxed">
              Automate customer support, capture leads, launch personalized campaigns, and close deals effortlessly 24/7.
            </p>
          </div>

          {/* Realistic Live WhatsApp AI Chat Simulation Card */}
          <div className="relative rounded-2xl bg-gradient-to-b from-slate-900/90 to-slate-950/90 border border-slate-800/80 p-5 shadow-2xl backdrop-blur-md max-w-xl">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-4">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
                <span className="text-xs font-semibold text-slate-200">AI Assistant • Live WhatsApp Session</span>
              </div>
              <span className="text-[11px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                Avg Response: 1.2s
              </span>
            </div>

            <div className="space-y-3 text-xs">
              {/* Customer message */}
              <div className="flex items-start gap-2 max-w-[85%]">
                <div className="w-6 h-6 rounded-full bg-slate-800 flex-shrink-0 flex items-center justify-center text-[10px] text-slate-300 font-bold">
                  C
                </div>
                <div className="bg-slate-800/90 text-slate-200 p-2.5 rounded-2xl rounded-tl-sm border border-slate-700/60 leading-relaxed shadow-sm">
                  Hello, I need 500 meters of 2-inch PVC pressure pipes. Can you deliver by Thursday to our warehouse?
                </div>
              </div>

              {/* AI Agent instant response */}
              <div className="flex items-start gap-2 max-w-[90%] ml-auto flex-row-reverse">
                <div className="w-6 h-6 rounded-full bg-emerald-600 flex-shrink-0 flex items-center justify-center text-[10px] text-white font-bold shadow-md shadow-emerald-500/20">
                  ⚡
                </div>
                <div className="bg-emerald-950/80 text-emerald-100 p-2.5 rounded-2xl rounded-tr-sm border border-emerald-500/30 leading-relaxed shadow-md">
                  Hello! Yes, standard 2-inch Class 3 PVC pipes are in stock. We can guarantee delivery by this Thursday. I've prepared your pro-forma quote. Shall I send it right here?
                  <div className="flex items-center justify-between text-[10px] text-emerald-400/80 mt-1.5 pt-1 border-t border-emerald-800/40">
                    <span>AI Auto-Qualified ✓</span>
                    <span>10:42 AM</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 4 Core Features Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
            <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-emerald-500/40 transition-all group">
              <div className="flex items-center gap-2.5 text-emerald-400 mb-1.5">
                <span className="text-base">⚡</span>
                <h3 className="font-semibold text-slate-200 text-sm group-hover:text-white transition-colors">24/7 AI Smart Agent</h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Autonomous conversations, intent detection, and seamless human handoff.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-cyan-500/40 transition-all group">
              <div className="flex items-center gap-2.5 text-cyan-400 mb-1.5">
                <span className="text-base">👁</span>
                <h3 className="font-semibold text-slate-200 text-sm group-hover:text-white transition-colors">Vision Lead Extractor</h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Extract business cards, phone numbers, and directory listings using AI-powered vision.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-teal-500/40 transition-all group">
              <div className="flex items-center gap-2.5 text-teal-400 mb-1.5">
                <span className="text-base">📢</span>
                <h3 className="font-semibold text-slate-200 text-sm group-hover:text-white transition-colors">Targeted Broadcasts</h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Launch personalized WhatsApp campaigns with scheduling and delivery safeguards.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-indigo-500/40 transition-all group">
              <div className="flex items-center gap-2.5 text-indigo-400 mb-1.5">
                <span className="text-base">🔐</span>
                <h3 className="font-semibold text-slate-200 text-sm group-hover:text-white transition-colors">Enterprise Security</h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Protected by Supabase authentication, encrypted sessions, and Row Level Security.
              </p>
            </div>
          </div>

          {/* Social Proof Badges */}
          <div className="flex items-center gap-6 text-xs text-slate-500 pt-1">
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Persistent WhatsApp WebSocket
            </span>
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Zero Human Bottlenecks
            </span>
          </div>
        </div>

        {/* =========================================================================
            RIGHT COLUMN: Premium SaaS Authentication Card
            ========================================================================= */}
        <div className="lg:col-span-5 order-1 lg:order-2">
          <div className="w-full bg-[#0D1322]/90 backdrop-blur-2xl border border-slate-800/90 rounded-3xl p-6 sm:p-9 shadow-2xl shadow-black/60 relative">
            
            {/* Subtle Top Glow Border */}
            <div className="absolute -top-[1px] left-1/4 right-1/4 h-[2px] bg-gradient-to-r from-transparent via-emerald-400/70 to-transparent" />

            {/* Notification Banner */}
            {notification.text && (
              <div
                className={`mb-6 p-4 rounded-xl text-sm flex items-start gap-3 border transition-all ${
                  notification.type === 'error'
                    ? 'bg-red-950/50 border-red-800/80 text-red-200'
                    : 'bg-emerald-950/50 border-emerald-800/80 text-emerald-200'
                }`}
              >
                <div className="text-base flex-shrink-0 mt-0.5">
                  {notification.type === 'error' ? '⚠️' : '✅'}
                </div>
                <div className="flex-1 text-xs sm:text-sm leading-relaxed">{notification.text}</div>
              </div>
            )}

            {/* Card Header & Title */}
            <div className="mb-6">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                {mode === 'signin' && 'Welcome back'}
                {mode === 'signup' && 'Create your account'}
                {mode === 'forgot' && 'Reset your password'}
              </h2>
              <p className="text-sm text-slate-400 mt-1.5">
                {mode === 'signin' && 'Sign in to continue to your AI Sales Suite.'}
                {mode === 'signup' && 'Start building your WhatsApp sales engine with AI.'}
                {mode === 'forgot' && 'Enter your account email to receive recovery instructions.'}
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleAuth} className="space-y-4" noValidate>
              
              {/* Full Name field (Signup only) */}
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
                      value={fullName}
                      onChange={(e) => {
                        setFullName(e.target.value);
                        if (errors.fullName) setErrors({ ...errors, fullName: null });
                      }}
                      placeholder="Bhavesh Sharma"
                      className={`w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950/80 border text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${
                        errors.fullName ? 'border-red-500 focus:border-red-500' : 'border-slate-800 focus:border-emerald-500'
                      }`}
                    />
                  </div>
                  {errors.fullName && <p className="mt-1 text-xs text-red-400">{errors.fullName}</p>}
                </div>
              )}

              {/* Email field */}
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
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (errors.email) setErrors({ ...errors, email: null });
                    }}
                    placeholder="name@company.com"
                    className={`w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950/80 border text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${
                      errors.email ? 'border-red-500 focus:border-red-500' : 'border-slate-800 focus:border-emerald-500'
                    }`}
                  />
                </div>
                {errors.email && <p className="mt-1 text-xs text-red-400">{errors.email}</p>}
              </div>

              {/* Password field */}
              {mode !== 'forgot' && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="password" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      Password
                    </label>
                    {mode === 'signin' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot');
                          setErrors({});
                          setNotification({ type: '', text: '' });
                        }}
                        className="text-xs text-emerald-400 hover:text-emerald-300 hover:underline transition-colors focus:outline-none"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    </div>
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (errors.password) setErrors({ ...errors, password: null });
                      }}
                      placeholder="••••••••"
                      className={`w-full pl-10 pr-11 py-2.5 rounded-xl bg-slate-950/80 border text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${
                        errors.password ? 'border-red-500 focus:border-red-500' : 'border-slate-800 focus:border-emerald-500'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-200 transition-colors focus:outline-none text-xs"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  {mode === 'signup' && (
                    <p className="mt-1 text-[11px] text-slate-400">Password must contain at least 8 characters.</p>
                  )}
                  {errors.password && <p className="mt-1 text-xs text-red-400">{errors.password}</p>}
                </div>
              )}

              {/* Confirm Password field (Signup only) */}
              {mode === 'signup' && (
                <div>
                  <label htmlFor="confirm-password" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    </div>
                    <input
                      id="confirm-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        if (errors.confirmPassword) setErrors({ ...errors, confirmPassword: null });
                      }}
                      placeholder="••••••••"
                      className={`w-full pl-10 pr-11 py-2.5 rounded-xl bg-slate-950/80 border text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${
                        errors.confirmPassword ? 'border-red-500 focus:border-red-500' : 'border-slate-800 focus:border-emerald-500'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-200 transition-colors focus:outline-none text-xs"
                      aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                    >
                      {showConfirmPassword ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  {errors.confirmPassword && <p className="mt-1 text-xs text-red-400">{errors.confirmPassword}</p>}
                </div>
              )}

              {/* Submit Button */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 shadow-lg shadow-emerald-500/25 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-sans"
                >
                  {loading && (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  {loading
                    ? 'Authenticating...'
                    : mode === 'signup'
                    ? 'Create Account'
                    : mode === 'forgot'
                    ? 'Send Password Reset Link'
                    : 'Sign In'}
                </button>
              </div>

              {/* Back to Sign In (if in Forgot mode) */}
              {mode === 'forgot' && (
                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signin');
                      setErrors({});
                      setNotification({ type: '', text: '' });
                    }}
                    className="text-xs text-slate-400 hover:text-emerald-400 transition-colors"
                  >
                    ← Back to Sign In
                  </button>
                </div>
              )}
            </form>

            {/* Switcher & Divider (Only in Signin / Signup mode) */}
            {mode !== 'forgot' && (
              <>
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-slate-800" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase tracking-wider">
                    <span className="bg-[#0D1322] px-3 text-slate-500 font-semibold">OR</span>
                  </div>
                </div>

                <div className="text-center text-xs text-slate-400">
                  {mode === 'signin' ? (
                    <>
                      Don't have an account?{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setMode('signup');
                          setErrors({});
                          setNotification({ type: '', text: '' });
                        }}
                        className="font-semibold text-emerald-400 hover:text-emerald-300 hover:underline transition-colors focus:outline-none"
                      >
                        Create account
                      </button>
                    </>
                  ) : (
                    <>
                      Already have an account?{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setMode('signin');
                          setErrors({});
                          setNotification({ type: '', text: '' });
                        }}
                        className="font-semibold text-emerald-400 hover:text-emerald-300 hover:underline transition-colors focus:outline-none"
                      >
                        Sign in
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

            {/* Card Footer */}
            <div className="mt-8 pt-5 border-t border-slate-800/80 flex items-center justify-center gap-2 text-[11px] text-slate-500">
              <svg className="w-3.5 h-3.5 text-emerald-400/80" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              <span>End-to-End Encrypted Sessions with Supabase Auth</span>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
}
