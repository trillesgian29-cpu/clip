import React from 'react';
import {
  Film,
  Sparkles,
  Database,
  Lock,
  Unlock,
  Settings,
  FolderOpen,
  PlusCircle,
  Cpu,
  Layers,
} from 'lucide-react';
import { SystemStatus } from '../types/index.ts';

interface NavbarProps {
  systemStatus: SystemStatus | null;
  isAuthenticated: boolean;
  onOpenAuth: () => void;
  onOpenSettings: () => void;
  onNewProject: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  systemStatus,
  isAuthenticated,
  onOpenAuth,
  onOpenSettings,
  onNewProject,
}) => {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-neutral-800/80 bg-neutral-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-violet-600 via-indigo-500 to-fuchsia-500 shadow-lg shadow-violet-500/20">
            <Film className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-white">ClipGenius</span>
              <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-violet-300 border border-violet-500/30">
                AI Studio
              </span>
            </div>
            <p className="text-xs text-neutral-400 hidden sm:block">
              AI-Powered Viral Shorts & FFmpeg Render Engine
            </p>
          </div>
        </div>

        {/* System Status Indicators */}
        <div className="hidden lg:flex items-center gap-2">
          {/* FFmpeg Indicator */}
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${
              systemStatus?.ffmpegAvailable
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            }`}
            title={systemStatus?.ffmpegVersion || 'FFmpeg engine status'}
          >
            <Cpu className="h-3.5 w-3.5" />
            <span>FFmpeg {systemStatus?.ffmpegAvailable ? 'Native Ready' : 'Standby'}</span>
          </div>

          {/* Gemini AI Indicator */}
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${
              systemStatus?.geminiConfigured
                ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
                : 'border-neutral-700 bg-neutral-900 text-neutral-400'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            <span>Gemini 3.8 Flash</span>
          </div>

          {/* Supabase Status */}
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${
              systemStatus?.supabaseConnected
                ? 'border-teal-500/30 bg-teal-500/10 text-teal-300'
                : 'border-neutral-700 bg-neutral-900 text-neutral-400'
            }`}
          >
            <Database className="h-3.5 w-3.5" />
            <span>{systemStatus?.supabaseConnected ? 'Supabase Postgres' : 'Local DB Sync'}</span>
          </div>

          {/* 20 GB Resumable Engine Chip */}
          <div
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border border-violet-500/30 bg-violet-500/10 text-violet-300"
            title="Resumable chunked upload protocol supporting up to 20 GB video files"
          >
            <Layers className="h-3.5 w-3.5 text-violet-400" />
            <span>20 GB Resumable</span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={onNewProject}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 transition"
            title="Start new video session"
          >
            <PlusCircle className="h-4 w-4 text-violet-400" />
            <span className="hidden sm:inline">New Session</span>
          </button>

          {/* Single Owner Auth Status */}
          <button
            onClick={onOpenAuth}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              isAuthenticated
                ? 'border border-emerald-500/40 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/40'
                : 'border border-amber-500/40 bg-amber-950/40 text-amber-300 hover:bg-amber-900/40'
            }`}
            title="Single-Owner Authentication"
          >
            {isAuthenticated ? (
              <>
                <Unlock className="h-3.5 w-3.5 text-emerald-400" />
                <span>Owner Active</span>
              </>
            ) : (
              <>
                <Lock className="h-3.5 w-3.5 text-amber-400" />
                <span>Owner Login</span>
              </>
            )}
          </button>

          {/* Settings */}
          <button
            onClick={onOpenSettings}
            className="rounded-lg border border-neutral-800 bg-neutral-900 p-2 text-neutral-400 hover:text-white hover:border-neutral-700 transition"
            title="Studio Settings & Diagnostics"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
