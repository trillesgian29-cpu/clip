import React, { useState } from 'react';
import { X, KeyRound, Lock, Unlock, ShieldCheck, AlertCircle } from 'lucide-react';
import { api } from '../services/api.ts';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  isAuthenticated: boolean;
  onAuthChange: (auth: boolean) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  isAuthenticated,
  onAuthChange,
}) => {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Passcode change fields
  const [showChangePass, setShowChangePass] = useState(false);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');

  if (!isOpen) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await api.loginOwner(passcode);
      onAuthChange(true);
      setSuccessMsg('Owner authentication verified!');
      setTimeout(() => {
        onClose();
        setSuccessMsg(null);
      }, 1000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    await api.logoutOwner();
    onAuthChange(false);
    setPasscode('');
    setError(null);
    onClose();
  };

  const handleChangePasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.changePasscode(currentPass, newPass);
      setSuccessMsg('Master passcode updated successfully!');
      setShowChangePass(false);
      setCurrentPass('');
      setNewPass('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl p-6 text-neutral-100">
        <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-violet-500/10 text-violet-400">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Owner Security Gate</h3>
              <p className="text-xs text-neutral-400">Single-owner studio access control</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-950/30 p-3 text-xs text-red-300">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/30 p-3 text-xs text-emerald-300">
            <ShieldCheck className="h-4 w-4 flex-shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {isAuthenticated ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="text-sm font-medium text-emerald-200">Owner Session Active</h4>
                  <p className="text-xs text-emerald-400/80">
                    Full privileges: AI clipping, FFmpeg rendering, Supabase sync.
                  </p>
                </div>
              </div>
            </div>

            {!showChangePass ? (
              <div className="flex flex-col gap-2 pt-2">
                <button
                  onClick={() => setShowChangePass(true)}
                  className="rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700 transition"
                >
                  Change Owner Passcode
                </button>
                <button
                  onClick={handleLogout}
                  className="rounded-lg border border-red-500/30 bg-red-950/20 px-4 py-2.5 text-xs font-medium text-red-300 hover:bg-red-900/40 transition"
                >
                  Log Out Owner Session
                </button>
              </div>
            ) : (
              <form onSubmit={handleChangePasscode} className="space-y-3 pt-2">
                <div>
                  <label className="block text-xs font-medium text-neutral-300 mb-1">
                    Current Passcode
                  </label>
                  <input
                    type="password"
                    value={currentPass}
                    onChange={(e) => setCurrentPass(e.target.value)}
                    required
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-300 mb-1">
                    New Passcode (min 6 chars)
                  </label>
                  <input
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    required
                    minLength={6}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    className="flex-1 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-500 transition"
                  >
                    Save New Passcode
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowChangePass(false)}
                    className="rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <form onSubmit={handleLogin} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                Owner Passcode / Master Key
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Enter passcode"
                  required
                  className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 focus:outline-none"
                />
                <Lock className="absolute right-3.5 top-3 h-4 w-4 text-neutral-500" />
              </div>
              <p className="mt-2 text-[11px] text-neutral-400">
                Default studio passcode is{' '}
                <button
                  type="button"
                  onClick={() => setPasscode('clipgenius-owner-2026')}
                  className="font-mono text-violet-400 underline hover:text-violet-300"
                >
                  clipgenius-owner-2026
                </button>{' '}
                (configured in <code className="text-neutral-300">.env</code>).
              </p>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-600/20 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-50 transition"
            >
              {isLoading ? 'Verifying...' : 'Unlock Studio Control'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
