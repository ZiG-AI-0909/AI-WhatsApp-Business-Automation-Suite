import React, { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from './supabaseClient';
import { friendlyErrorMessage } from './utils/errorMessages.js';
import BrandLogo from './components/BrandLogo.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import Icon from './components/Icon.jsx';

const CURRENT_YEAR = new Date().getFullYear();

// ─── Password strength helper ──────────────────────────────────────────────────
function getPasswordStrength(pw) {
  if (!pw) return { level: 0, label: '', tone: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { level: 1, label: 'Weak', tone: 'danger' };
  if (score <= 3) return { level: 2, label: 'Fair', tone: 'warning' };
  return { level: 3, label: 'Strong', tone: 'success' };
}

// ─── Google "G" logo SVG ────────────────────────────────────────────────────────
function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
    <div className={`notice ${isError ? 'error' : 'success'} auth-notice`} role={isError ? 'alert' : 'status'}>
      <span>{text}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="icon-btn auth-notice-dismiss" aria-label="Dismiss message"><Icon name="close" size={16} /></button>
      )}
    </div>
  );
}

// ─── PasswordField with toggle ─────────────────────────────────────────────────
function PasswordField({ id, label, value, onChange, autoComplete, error, showStrength, action }) {
  const [show, setShow] = useState(false);
  const strength = showStrength ? getPasswordStrength(value) : null;
  return (
    <div className="form-label">
      <div className="auth-row">
        <label htmlFor={id}>{label}</label>
        {action}
      </div>
      <div className="auth-password">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          placeholder="••••••••"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={error ? 'auth-input-invalid' : ''}
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          className="auth-password-toggle"
          aria-label={show ? 'Hide password' : 'Show password'}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {showStrength && value && (
        <div className="auth-strength">
          <div className="auth-strength-bars" aria-hidden="true">
            {[1, 2, 3].map(i => (
              <span key={i} style={i <= strength.level ? { background: `var(--${strength.tone})` } : undefined} />
            ))}
          </div>
          <small style={{ color: `var(--${strength.tone}-text)` }}>Password strength: {strength.label}</small>
        </div>
      )}
      {error && <p id={`${id}-error`} className="auth-field-error" role="alert">{error}</p>}
    </div>
  );
}

// ─── Google OAuth button ────────────────────────────────────────────────────────
function GoogleButton({ loading, onClick, label }) {
  return (
    <button type="button" onClick={onClick} disabled={loading} className="secondary-btn auth-google">
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : <GoogleLogo />}
      {loading ? 'Redirecting to Google…' : label}
    </button>
  );
}

// ─── Divider ──────────────────────────────────────────────────────────────────
function Divider() {
  return <div className="auth-divider"><span>or</span></div>;
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
  const err = (field) => errors[field] && <p id={`${field}-error`} className="auth-field-error" role="alert">{errors[field]}</p>;

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
      setNotice({ type: 'error', text: friendlyErrorMessage(err, { context: 'Google sign-in', fallback: 'Google sign-in failed. Please try again.' }) });
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
        if (error) {
          throw new Error(friendlyErrorMessage(error, { context: 'Forgot password', log: false }));
        }
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
          throw new Error(friendlyErrorMessage(error, { context: 'Reset password', log: false }));
        }
        setNotice({ type: 'success', text: 'Password updated successfully! Please sign in with your new password.' });
        setTimeout(() => switchMode('signin'), 2000);
        return;
      }
    } catch (err) {
      setNotice({ type: 'error', text: friendlyErrorMessage(err, { context: 'Auth form', fallback: 'Something went wrong. Please try again.' }) });
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
      setNotice({ type: 'error', text: friendlyErrorMessage(err, { context: 'Resend verification', fallback: 'Failed to resend. Please try again shortly.' }) });
    } finally {
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  const title = {
    signin: 'Welcome back',
    signup: 'Create your account',
    forgot: 'Reset your password',
    'verify-email': 'Check your email',
    'reset-password': 'Set new password',
  }[mode];
  const subtitle = {
    signin: 'Sign in to continue to your AI Sales Suite.',
    signup: 'Start building your WhatsApp sales engine with AI.',
    forgot: 'Enter your email to receive a password reset link.',
    'reset-password': 'Choose a strong password for your account.',
  }[mode];

  return (
    <div className="auth-page">
      <div className="auth-mesh" aria-hidden="true" />
      <div className="auth-topbar"><ThemeToggle /></div>

      <main className="auth-card" aria-labelledby="auth-title">
        <a href="#/" className="ghost-btn auth-back"><Icon name="chevron-left" size={16} /> Back to home</a>

        <div className="auth-brand">
          <BrandLogo height={58} />
          <p className="auth-product">AI Assistant</p>
        </div>

        <h1 id="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}

        <Notice type={notice.type} text={notice.text} onDismiss={clearNotice} />

        {/* ── EMAIL VERIFICATION SCREEN ── */}
        {mode === 'verify-email' && (
          <div className="auth-form">
            <span className="empty-state-icon auth-verify-icon" aria-hidden="true"><Icon name="mail" size={26} /></span>
            <p className="auth-subtitle">
              We sent a verification link to{' '}
              <strong>{verifyEmail || 'your email address'}</strong>.
              Click the link in the email to activate your account.
            </p>
            <div className="notice info">
              <span>Check your <strong>spam or junk folder</strong> if you don't see it within 2 minutes. The link expires after <strong>24 hours</strong>.</span>
            </div>
            <button
              type="button"
              onClick={handleResendVerification}
              disabled={loading || resendCooldown > 0}
              className="primary-btn"
            >
              {loading ? 'Sending…' : resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend verification email'}
            </button>
            <button type="button" onClick={() => switchMode('signup')} className="auth-link">
              Change email / return to sign up
            </button>
          </div>
        )}

        {/* ── RESET PASSWORD SCREEN ── */}
        {mode === 'reset-password' && (
          <form onSubmit={handleSubmit} className="auth-form" noValidate>
            <PasswordField
              id="new-password"
              label="New password"
              value={password}
              onChange={e => { setPassword(e.target.value); setErrors(p => ({ ...p, password: null })) }}
              autoComplete="new-password"
              error={errors.password}
              showStrength
            />
            <PasswordField
              id="confirm-new-password"
              label="Confirm new password"
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); setErrors(p => ({ ...p, confirmPassword: null })) }}
              autoComplete="new-password"
              error={errors.confirmPassword}
            />
            <button type="submit" disabled={loading} className="primary-btn">
              {loading && <span className="btn-spinner" aria-hidden="true" />}
              {loading ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        )}

        {/* ── SIGN IN / SIGN UP / FORGOT ── */}
        {(mode === 'signin' || mode === 'signup' || mode === 'forgot') && (
          <>
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
            <form onSubmit={handleSubmit} className="auth-form" noValidate>

              {/* Full name — signup only */}
              {mode === 'signup' && (
                <div className="form-label">
                  <label htmlFor="full-name">Full name</label>
                  <input
                    id="full-name"
                    type="text"
                    autoComplete="name"
                    value={fullName}
                    onChange={e => { setFullName(e.target.value); setErrors(p => ({ ...p, fullName: null })) }}
                    placeholder="Your full name"
                    aria-invalid={errors.fullName ? 'true' : undefined}
                    aria-describedby={errors.fullName ? 'fullName-error' : undefined}
                    className={errors.fullName ? 'auth-input-invalid' : ''}
                  />
                  {err('fullName')}
                </div>
              )}

              {/* Email */}
              <div className="form-label">
                <label htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setErrors(p => ({ ...p, email: null })) }}
                  placeholder="name@company.com"
                  aria-invalid={errors.email ? 'true' : undefined}
                  aria-describedby={errors.email ? 'email-error' : undefined}
                  className={errors.email ? 'auth-input-invalid' : ''}
                />
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
                    <button type="button" onClick={() => switchMode('forgot')} className="auth-link">
                      Forgot password?
                    </button>
                  )}
                />
              )}

              {/* Confirm password — signup only */}
              {mode === 'signup' && (
                <PasswordField
                  id="confirm-password"
                  label="Confirm password"
                  value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); setErrors(p => ({ ...p, confirmPassword: null })) }}
                  autoComplete="new-password"
                  error={errors.confirmPassword}
                />
              )}

              {/* Terms — signup only */}
              {mode === 'signup' && (
                <div>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={termsAccepted}
                      onChange={e => { setTermsAccepted(e.target.checked); setErrors(p => ({ ...p, terms: null })) }}
                      aria-invalid={errors.terms ? 'true' : undefined}
                      aria-describedby={errors.terms ? 'terms-error' : undefined}
                    />
                    <span>I agree to the Terms of Service and Privacy Policy.</span>
                  </label>
                  {err('terms')}
                </div>
              )}

              {/* Submit */}
              <button type="submit" disabled={loading || googleLoading} className="primary-btn">
                {loading && <span className="btn-spinner" aria-hidden="true" />}
                {loading
                  ? 'Authenticating…'
                  : mode === 'signup'
                    ? 'Create Account'
                    : mode === 'forgot'
                      ? 'Send Reset Link'
                      : 'Sign In'}
              </button>

              {/* Forgot: back to sign in + resend */}
              {mode === 'forgot' && (
                <div className="auth-switch">
                  {resendCooldown > 0 && <p className="file-note">You can resend in {resendCooldown}s.</p>}
                  <button type="button" onClick={() => switchMode('signin')} className="auth-link">
                    Back to sign in
                  </button>
                </div>
              )}
            </form>

            {/* Mode switcher */}
            {mode !== 'forgot' && (
              <p className="auth-switch">
                {mode === 'signin' ? (
                  <>
                    Don't have an account?{' '}
                    <button type="button" onClick={() => switchMode('signup')} className="auth-link">Create account</button>
                  </>
                ) : (
                  <>
                    Already have an account?{' '}
                    <button type="button" onClick={() => switchMode('signin')} className="auth-link">Sign in</button>
                  </>
                )}
              </p>
            )}
          </>
        )}

        {/* Card footer */}
        <p className="auth-footer"><Icon name="shield" size={14} /> Secured by Supabase Auth · Encrypted sessions</p>
        <p className="auth-footer">© {CURRENT_YEAR} Sudarshan Pipes &amp; Fittings · AI Assistant</p>
      </main>
    </div>
  );
}
