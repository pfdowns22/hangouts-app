import React, { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import {
  signInAnonymously,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  OAuthProvider,
  signOut,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  addDoc,
  arrayUnion,
  arrayRemove,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  orderBy,
  limit,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

import { auth, db, storage, appId, geminiApiKey } from './firebase.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;

// Image fallback chain when Gemini's imageUrl is null or 404s.
// Priority order:
// 1. Unsplash API (real photos, fast CDN) — used if VITE_UNSPLASH_KEY is set
// 2. pollinations.ai turbo (AI-generated, no key) — slower but works without setup
// 3. placehold.co text card — final fallback, always loads
const UNSPLASH_KEY = import.meta.env.VITE_UNSPLASH_KEY || '';

const pollinationsImage = (keywords) => {
  const q = (keywords || 'social event').slice(0, 100);
  // model=turbo is ~3x faster than flux; smaller dims generate quicker too.
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(q)}?width=600&height=300&nologo=true&model=turbo`;
};

const textPlaceholder = (title) => {
  const t = (title || 'Event').slice(0, 50);
  return `https://placehold.co/800x400/6366f1/ffffff/png?text=${encodeURIComponent(t)}`;
};

// Cache Unsplash search results per-query within the page session so we
// don't burn the free-tier 50/hr quota on repeat renders of the same event.
const unsplashCache = new Map();

// React hook: returns the best image URL for an event.
// When VITE_UNSPLASH_KEY is configured, Unsplash is *always* the primary
// source — Gemini's claimed imageUrls are notoriously unreliable (often
// pointing at images that 404 or aren't really images at all). We only
// fall back to Gemini's URL or pollinations if Unsplash has no results.
const useEventImage = (data) => {
  // Optimistic starting state: when no Unsplash key, fall back immediately
  // to pollinations so users see *something* before any async work.
  const [src, setSrc] = useState(
    UNSPLASH_KEY ? null : (data?.imageUrl || pollinationsImage(data?.imageKeywords || data?.title))
  );

  useEffect(() => {
    const query = (data?.imageKeywords || data?.title || 'event').slice(0, 80);

    // No Unsplash key: defer to Gemini's URL (if any) or pollinations.
    if (!UNSPLASH_KEY) {
      setSrc(data?.imageUrl || pollinationsImage(query));
      return;
    }

    // With Unsplash configured, always try Unsplash first.
    if (unsplashCache.has(query)) {
      setSrc(unsplashCache.get(query));
      return;
    }
    let cancelled = false;
    fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&client_id=${UNSPLASH_KEY}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const url = j?.results?.[0]?.urls?.regular;
        if (url) {
          unsplashCache.set(query, url);
          setSrc(url);
        } else {
          // Unsplash returned no results — try Gemini's URL, then pollinations.
          setSrc(data?.imageUrl || pollinationsImage(query));
        }
      })
      .catch(() => {
        if (!cancelled) setSrc(data?.imageUrl || pollinationsImage(query));
      });
    return () => { cancelled = true; };
  }, [data?.imageUrl, data?.title, data?.imageKeywords]);

  return src;
};

// Gemini doesn't allow `tools: [{google_search:{}}]` together with
// `responseSchema: application/json`. For grounded calls we parse JSON
// out of the model's text output instead of relying on schema enforcement.
const extractJsonArray = (text) => {
  if (!text) return null;
  // Try fenced code block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  // Find first '[' and last ']' to isolate the array
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

// --- Context ---
const AppContext = createContext(null);

// --- Icons ---
const Icon = ({ path, className = 'w-6 h-6' }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={path}></path>
  </svg>
);
const MenuIcon = () => <Icon path="M4 6h16M4 12h16M4 18h16" />;
const UserIcon = () => <Icon path="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />;
const SettingsIcon = () => <Icon path="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />;
const InfoIcon = () => <Icon path="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />;
const CloseIcon = ({ className = 'w-6 h-6' }) => <Icon path="M6 18L18 6M6 6l12 12" className={className} />;
const PlusIcon = ({ className = 'w-6 h-6' }) => <Icon path="M12 4v16m8-8H4" className={className} />;
const TrashIcon = ({ className = 'w-6 h-6' }) => <Icon path="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" className={className} />;
const SparklesIcon = ({ className = 'w-6 h-6' }) => <Icon path="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.293 2.293a1 1 0 010 1.414L15 12l-1.293 1.293a1 1 0 01-1.414 0L10 10.414l-1.293 1.293a1 1 0 01-1.414 0L5 9.414l-1.293 1.293a1 1 0 01-1.414-1.414L4.586 7.707a1 1 0 011.414 0L7.293 9l1.293-1.293a1 1 0 011.414 0L12 10.414l1.293-1.293a1 1 0 011.414 0L17 11.414l1.293-1.293a1 1 0 011.414 0L21 11.414" className={className} />;
const LightbulbIcon = ({ className = 'w-6 h-6' }) => <Icon path="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 017.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" className={className} />;
const UsersIcon = ({ className = 'w-6 h-6' }) => <Icon path="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" className={className} />;
const CalendarIcon = ({ className = 'w-6 h-6' }) => <Icon path="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" className={className} />;
const HeartIcon = ({ className = 'w-6 h-6' }) => <Icon path="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" className={className} />;
const SendIcon = ({ className = 'w-6 h-6' }) => <Icon path="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" className={className} />;
const LogoutIcon = () => <Icon path="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />;
const GoogleIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 48 48">
    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C12.955 4 4 12.955 4 24s8.955 20 20 20s20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"></path>
    <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C16.318 4 9.656 8.337 6.306 14.691z"></path>
    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.222 0-9.519-3.534-11.082-8.192l-6.823 5.34C9.042 39.572 15.846 44 24 44z"></path>
    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C42.021 35.596 44 30.138 44 24c0-1.341-.138-2.65-.389-3.917z"></path>
  </svg>
);
const AppleIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24">
    <path fill="currentColor" d="M19.3,4.24a5.12,5.12,0,0,0-4.43,2.25,5.33,5.33,0,0,0-4.39-2.25C8.09,4.24,5.5,6.1,5.5,9.26A6,6,0,0,0,7,12.55a5.87,5.87,0,0,0,1.63,3.35,6.56,6.56,0,0,0,4,2.15,6.38,6.38,0,0,0,4.88-2.58,1.36,1.36,0,0,1,1-.58,1.14,1.14,0,0,1,.8.4,1.4,1.4,0,0,0,1,.58,1.54,1.54,0,0,0,1.5-1.55A5.73,5.73,0,0,0,19.3,4.24ZM12.15,2.75a3.13,3.13,0,0,1,2.23.9,3.33,3.33,0,0,1,1.1,2.4,3.58,3.58,0,0,1-2.2,3.23,3.21,3.21,0,0,1-3.46-2.1A3.35,3.35,0,0,1,12.15,2.75Z"></path>
  </svg>
);
const CameraIcon = ({ className = 'w-6 h-6' }) => <Icon path="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" className={className} />;
const LeaveIcon = () => <Icon path="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />;
const SyncIcon = ({ className = 'w-6 h-6' }) => <Icon path="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" className={className} />;
const SearchIcon = ({ className = 'w-6 h-6' }) => <Icon path="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" className={className} />;
const ChatIcon = ({ className = 'w-6 h-6' }) => <Icon path="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" className={className} />;
const CopyIcon = ({ className = 'w-6 h-6' }) => <Icon path="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" className={className} />;
const MailIcon = ({ className = 'w-6 h-6' }) => <Icon path="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" className={className} />;
const InviteIcon = ({ className = 'w-6 h-6' }) => <Icon path="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" className={className} />;
const ShareIcon = ({ className = 'w-6 h-6' }) => <Icon path="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8m-4-6l-4-4-4 4m4-4v12" className={className} />;

// --- Calendar Utilities ---
const generateICSFile = (suggestion) => {
  const { title, description, location, date } = suggestion;
  const startDate = new Date(date);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const toICSDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HangoutsApp//NONSGML v1.0//EN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@hangouts.app`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(startDate)}`,
    `DTEND:${toICSDate(endDate)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    `LOCATION:${location}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${title.replace(/ /g, '_')}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const addToGoogleCalendar = async (suggestion, token, showMsg) => {
  try {
    const { title, description, location, date } = suggestion;
    const startDate = new Date(date);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    const event = {
      summary: title,
      location,
      description,
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    };
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error('API Error');
    showMsg('Event saved securely to your Google Calendar!', 'success');
    return true;
  } catch (error) {
    console.error(error);
    showMsg('Failed to add to Google Calendar.', 'error');
    return false;
  }
};

// --- Avatar ---
const Avatar = ({ src, alt, size = 'md', className = '' }) => {
  const sizeClasses = { xs: 'w-6 h-6', sm: 'w-8 h-8', md: 'w-10 h-10', lg: 'w-24 h-24', xl: 'w-32 h-32' };
  const initial = alt ? alt.charAt(0).toUpperCase() : '?';
  return (
    <div className={`${sizeClasses[size]} ${className} rounded-full overflow-hidden flex-shrink-0 bg-indigo-100 flex items-center justify-center border-2 border-white shadow-sm`}>
      {src ? (
        <img src={src} alt={alt} className="w-full h-full object-cover" />
      ) : (
        <span className="text-indigo-500 font-bold text-xs">{initial}</span>
      )}
    </div>
  );
};

// --- UI Components ---
const Modal = ({ children, onClose, title }) => (
  <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-center items-center p-4 transition-all" onClick={onClose}>
    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col" onClick={(e) => e.stopPropagation()}>
      <header className="flex justify-between items-center p-5 border-b border-gray-100 bg-white sticky top-0 z-10">
        <h2 className="text-xl font-bold text-gray-800">{title}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-2 rounded-full hover:bg-gray-100 transition">
          <CloseIcon />
        </button>
      </header>
      <div className="p-6">{children}</div>
    </div>
  </div>
);

const UserProfileDropdown = () => {
  const { userId, userProfile, setShowProfileModal, setShowSettingsModal, setShowAboutModal } = useContext(AppContext);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!userId) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button onClick={() => setIsOpen(!isOpen)} className="flex items-center gap-3 bg-white/60 backdrop-blur-md hover:bg-white/80 py-1 pl-1 pr-4 rounded-full shadow-sm border border-white/20 transition-all">
        <Avatar src={userProfile?.photoURL} alt={userProfile?.name} size="sm" />
        <span className="text-sm font-medium text-gray-700 hidden sm:block">{userProfile?.name?.split(' ')[0] || 'User'}</span>
        <MenuIcon />
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-xl py-2 z-40 border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
            <p className="text-sm font-bold text-gray-900">{userProfile?.name || 'User'}</p>
            <p className="text-xs text-gray-500 truncate">{userId}</p>
          </div>
          <button onClick={() => { setShowProfileModal(true); setIsOpen(false); }} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-indigo-50 transition-colors">
            <UserIcon /> My Profile
          </button>
          <button onClick={() => { setShowSettingsModal(true); setIsOpen(false); }} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-indigo-50 transition-colors">
            <SettingsIcon /> Settings
          </button>
          <button onClick={() => { setShowAboutModal(true); setIsOpen(false); }} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-indigo-50 transition-colors">
            <InfoIcon /> About Hangouts
          </button>
          <div className="border-t border-gray-100 my-1"></div>
          <button onClick={() => signOut(auth)} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-red-600 hover:bg-red-50 transition-colors">
            <LogoutIcon /> Sign Out
          </button>
        </div>
      )}
    </div>
  );
};

const Header = () => (
  <header className="relative z-30 mb-8 flex justify-between items-center">
    <h1 className="text-3xl font-extrabold text-indigo-900 tracking-tight">Hangouts</h1>
    <UserProfileDropdown />
  </header>
);

const TabButton = ({ label, tabName, activeTab, setActiveTab, badge }) => (
  <button
    className={`relative px-6 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 whitespace-nowrap ${
      activeTab === tabName ? 'bg-white text-indigo-600 shadow-sm transform scale-105' : 'text-gray-600 hover:bg-white/50'
    }`}
    onClick={() => setActiveTab(tabName)}
  >
    {label}
    {badge > 0 && (
      <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1.5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center shadow">
        {badge > 9 ? '9+' : badge}
      </span>
    )}
  </button>
);

const MainContent = () => {
  const [activeTab, setActiveTab] = useState('myFeed');
  const { unreadFeedCount, markFeedRead } = useContext(AppContext);

  // When the user lands on (or returns to) the My Feed tab, clear the unread badge.
  useEffect(() => {
    if (activeTab === 'myFeed' && unreadFeedCount > 0) markFeedRead();
  }, [activeTab, unreadFeedCount, markFeedRead]);

  return (
    <div className="max-w-6xl mx-auto">
      <nav className="mb-8 flex justify-center">
        <div className="bg-white/40 backdrop-blur-lg p-1.5 rounded-2xl shadow-sm inline-flex overflow-x-auto max-w-full">
          <TabButton label="My Feed" tabName="myFeed" activeTab={activeTab} setActiveTab={setActiveTab} badge={unreadFeedCount} />
          <TabButton label="My Groups" tabName="groups" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton label="Suggestions" tabName="suggestions" activeTab={activeTab} setActiveTab={setActiveTab} />
        </div>
      </nav>
      <div className="bg-white/60 backdrop-blur-xl rounded-3xl shadow-xl border border-white/40 p-4 md:p-6 min-h-[60vh]">
        {activeTab === 'myFeed' && <MyFeedSection />}
        {activeTab === 'groups' && <GroupSection />}
        {activeTab === 'suggestions' && <SuggestionSection />}
      </div>
    </div>
  );
};

// --- Modals ---
const ProfileModal = ({ onClose }) => (
  <Modal onClose={onClose} title="Edit Profile">
    <ProfileSection onClose={onClose} />
  </Modal>
);
const SettingsModal = ({ onClose }) => (
  <Modal onClose={onClose} title="Settings">
    <SettingsSection onClose={onClose} />
  </Modal>
);
const AboutModal = ({ onClose }) => (
  <Modal onClose={onClose} title="About Hangouts">
    <div className="space-y-4 text-gray-600 leading-relaxed">
      <p className="text-lg text-gray-800 font-medium">Simplify your social life.</p>
      <p>Hangouts uses advanced AI with live Search Grounding to find the perfect real activity for any group, taking into account everyone's schedule, location, and preferences.</p>
      <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
        <h4 className="font-bold text-indigo-900 mb-2">New in 3.0</h4>
        <ul className="list-disc list-inside space-y-1 text-sm">
          <li>Live Google Search Grounded Event Discovery</li>
          <li>Event Thumbnails &amp; "More Info" Booking links</li>
          <li>Direct Google Calendar Sync Integration</li>
          <li>"Ideas for Today" quick generation</li>
        </ul>
      </div>
    </div>
  </Modal>
);

const SettingsSection = ({ onClose }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage } = useContext(AppContext);
  const [allowLocation, setAllowLocation] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (userProfile) setAllowLocation(userProfile.allowLocationTracking || false);
  }, [userProfile]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { allowLocationTracking: allowLocation });
      setUserProfile((prev) => ({ ...prev, allowLocationTracking: allowLocation }));
      showGlobalMessage('Settings updated.');
      onClose();
    } catch (error) {
      showGlobalMessage('Failed to save settings.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
        <div>
          <h3 className="font-medium text-gray-900">Location Services</h3>
          <p className="text-sm text-gray-500">Enable specifically for localized suggestions.</p>
        </div>
        <input
          type="checkbox"
          checked={allowLocation}
          onChange={(e) => setAllowLocation(e.target.checked)}
          className="w-6 h-6 text-indigo-600 rounded focus:ring-indigo-500 border-gray-300"
        />
      </div>
      <div className="flex justify-end">
        <button onClick={handleSave} disabled={isSaving} className="bg-indigo-600 text-white font-medium py-2 px-6 rounded-xl hover:bg-indigo-700 transition">
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

const ProfileSection = ({ onClose }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage, googleAccessToken } = useContext(AppContext);
  const [name, setName] = useState(userProfile?.name || '');
  const [address, setAddress] = useState(userProfile?.address || '');
  const [kids, setKids] = useState(userProfile?.kids || []);
  const [newKidName, setNewKidName] = useState('');
  const [newKidAge, setNewKidAge] = useState('');
  const [preferences, setPreferences] = useState(userProfile?.preferences || []);
  const [currentPreference, setCurrentPreference] = useState('');
  const [availableDates, setAvailableDates] = useState(userProfile?.availability || []);
  const [timeOfDayPrefs, setTimeOfDayPrefs] = useState(userProfile?.timeOfDayPrefs || []);
  const [dayOfWeekPrefs, setDayOfWeekPrefs] = useState(userProfile?.dayOfWeekPrefs || []);
  const [freeSlots, setFreeSlots] = useState(userProfile?.freeSlots || []);
  const [isSaving, setIsSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzingCalendar, setAnalyzingCalendar] = useState(false);

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const storageRef = ref(storage, `users/${userId}/profile_${Date.now()}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { photoURL: url });
      setUserProfile((prev) => ({ ...prev, photoURL: url }));
      showGlobalMessage('Profile picture updated!');
    } catch (error) {
      console.error(error);
      showGlobalMessage('Failed to upload image.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleSaveProfile = async () => {
    setIsSaving(true);
    try {
      const update = {
        name,
        address,
        kids,
        preferences,
        availability: availableDates,
        timeOfDayPrefs,
        dayOfWeekPrefs,
        freeSlots,
      };
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), update);
      setUserProfile((prev) => ({ ...prev, ...update }));
      showGlobalMessage('Profile saved successfully!');
      onClose();
    } catch (e) {
      showGlobalMessage('Error saving profile.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const togglePref = (list, setter, value) =>
    setter(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  const analyzeCalendarWithGemini = async () => {
    if (!googleAccessToken) {
      showGlobalMessage('Google Calendar access required. Please sign out and sign back in to grant permission.', 'error');
      return;
    }
    if (!geminiApiKey) {
      showGlobalMessage('Gemini API key missing. Set VITE_GEMINI_API_KEY in your environment.', 'error');
      return;
    }
    setAnalyzingCalendar(true);
    try {
      const now = new Date();
      const nextMonth = new Date();
      nextMonth.setDate(now.getDate() + 30);
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${nextMonth.toISOString()}&singleEvents=true&orderBy=startTime`,
        { headers: { Authorization: `Bearer ${googleAccessToken}` } }
      );
      if (!res.ok) throw new Error('Failed to fetch calendar data.');
      const calendarData = await res.json();
      const events = calendarData.items
        ? calendarData.items.map((e) => ({ start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date, summary: e.summary }))
        : [];

      const prompt = `Here is a list of my calendar events for the next 30 days: ${JSON.stringify(events)}.
Analyze my schedule and identify SPECIFIC FREE TIME BLOCKS where I could realistically attend a 1-3 hour social hangout.
Rules:
- Assume my "social hours" are roughly 9:00 to 22:00 local time (not overnight).
- A free block must be at least 90 minutes long with no conflicting events.
- Prefer evenings (after 17:00) and weekend afternoons; only suggest weekday daytime blocks if I have a clearly open calendar.
- Skip any block that ends less than 30 minutes before the next event (need transit/buffer time).
- Cap at the 25 best blocks.
Return strictly a JSON array (no prose, no markdown fences) of objects with shape:
{ "date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM", "label": "short human label like 'Tue evening' or 'Sat afternoon'" }`;

      const geminiRes = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  date: { type: 'STRING' },
                  start: { type: 'STRING' },
                  end: { type: 'STRING' },
                  label: { type: 'STRING' },
                },
                required: ['date', 'start', 'end'],
              },
            },
          },
        }),
      });
      const data = await geminiRes.json();
      if (!data.candidates) throw new Error('AI generated empty response.');
      const slots = JSON.parse(data.candidates[0].content.parts[0].text);
      setFreeSlots(slots);
      // Keep the day-level checked state in sync so the calendar reflects which days have any availability
      const days = [...new Set(slots.map((s) => s.date))].sort();
      setAvailableDates((prev) => [...new Set([...prev, ...days])].sort());
      showGlobalMessage(`Synced! Found ${slots.length} free time blocks across ${days.length} days.`);
    } catch (error) {
      console.error(error);
      showGlobalMessage('Could not sync calendar.', 'error');
    } finally {
      setAnalyzingCalendar(false);
    }
  };

  const addKid = () => {
    if (newKidName && newKidAge) {
      setKids([...kids, { name: newKidName, age: parseInt(newKidAge, 10) }]);
      setNewKidName('');
      setNewKidAge('');
    }
  };
  const removeKid = (i) => setKids(kids.filter((_, idx) => idx !== i));
  const addPreference = () => {
    if (currentPreference && !preferences.includes(currentPreference)) {
      setPreferences([...preferences, currentPreference]);
      setCurrentPreference('');
    }
  };
  const removePreference = (p) => setPreferences(preferences.filter((pref) => pref !== p));
  const handleDateToggle = (d) =>
    setAvailableDates((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-6">
        <div className="relative group">
          <Avatar src={userProfile?.photoURL} alt={name} size="xl" />
          <label className="absolute inset-0 bg-black/30 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-white">
            <CameraIcon className="w-8 h-8" />
            <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} disabled={uploading} />
          </label>
          {uploading && (
            <div className="absolute inset-0 bg-white/50 flex items-center justify-center rounded-full">
              <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}
        </div>
        <div className="flex-1 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Display Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Home Base (City/Zip)</label>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. New York, NY" className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <h3 className="font-bold text-gray-800 mb-3 flex items-center gap-2">
            <HeartIcon className="w-5 h-5 text-pink-500" /> Preferences
          </h3>
          <div className="flex flex-wrap gap-2 mb-3">
            {preferences.map((pref) => (
              <span key={pref} className="flex items-center bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-sm font-medium border border-indigo-100">
                {pref}
                <button onClick={() => removePreference(pref)} className="ml-2 hover:text-indigo-900">
                  <CloseIcon className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={currentPreference}
              onChange={(e) => setCurrentPreference(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPreference()}
              className="flex-1 p-2 bg-gray-50 border border-gray-200 rounded-lg text-sm"
              placeholder="e.g. Hiking, Live Music"
            />
            <button onClick={addPreference} className="p-2 bg-indigo-100 text-indigo-600 rounded-lg hover:bg-indigo-200">
              <PlusIcon />
            </button>
          </div>
        </div>
        <div>
          <h3 className="font-bold text-gray-800 mb-3 flex items-center gap-2">
            <UsersIcon className="w-5 h-5 text-blue-500" /> Family
          </h3>
          <div className="space-y-2 mb-3">
            {kids.map((kid, i) => (
              <div key={i} className="flex justify-between items-center bg-gray-50 p-2 rounded-lg text-sm">
                <span>
                  {kid.name} <span className="text-gray-400">({kid.age}y)</span>
                </span>
                <button onClick={() => removeKid(i)} className="text-red-400 hover:text-red-600">
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newKidName} onChange={(e) => setNewKidName(e.target.value)} className="flex-1 p-2 bg-gray-50 border border-gray-200 rounded-lg text-sm" placeholder="Name" />
            <input type="number" value={newKidAge} onChange={(e) => setNewKidAge(e.target.value)} className="w-16 p-2 bg-gray-50 border border-gray-200 rounded-lg text-sm" placeholder="Age" />
            <button onClick={addKid} className="p-2 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200">
              <PlusIcon />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="font-bold text-gray-800">When are you usually free?</h3>
        <div>
          <label className="block text-xs font-semibold uppercase text-gray-500 mb-2">Times of day</label>
          <div className="flex flex-wrap gap-2">
            {['Mornings', 'Afternoons', 'Evenings'].map((slot) => {
              const active = timeOfDayPrefs.includes(slot);
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => togglePref(timeOfDayPrefs, setTimeOfDayPrefs, slot)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                    active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'
                  }`}
                >
                  {slot}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase text-gray-500 mb-2">Days of week</label>
          <div className="flex flex-wrap gap-2">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => {
              const active = dayOfWeekPrefs.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => togglePref(dayOfWeekPrefs, setDayOfWeekPrefs, day)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                    active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-gray-800">Availability Calendar</h3>
          <button onClick={analyzeCalendarWithGemini} disabled={analyzingCalendar} className="text-xs bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1 hover:bg-indigo-100 transition disabled:opacity-50">
            {analyzingCalendar ? (
              <div className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            ) : (
              <SyncIcon className="w-4 h-4" />
            )}
            Analyze with Gemini
          </button>
        </div>
        <CalendarPicker selectedDates={availableDates} onDateToggle={handleDateToggle} />
        {freeSlots.length > 0 && (
          <div className="mt-4 bg-indigo-50 border border-indigo-100 rounded-xl p-4">
            <h4 className="text-sm font-bold text-indigo-900 mb-2">Free time blocks ({freeSlots.length})</h4>
            <div className="max-h-48 overflow-y-auto space-y-1 text-sm text-indigo-800">
              {freeSlots.map((s, i) => (
                <div key={i} className="flex justify-between gap-2 py-1 border-b border-indigo-100 last:border-0">
                  <span className="font-medium">{s.label || s.date}</span>
                  <span className="font-mono text-xs">{s.date} · {s.start}–{s.end}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-end pt-4 border-t">
        <button onClick={handleSaveProfile} disabled={isSaving} className="bg-indigo-600 text-white font-bold py-3 px-8 rounded-xl hover:bg-indigo-700 transition shadow-lg shadow-indigo-200">
          {isSaving ? 'Saving...' : 'Save Profile'}
        </button>
      </div>
    </div>
  );
};

const CalendarPicker = ({ selectedDates, onDateToggle }) => {
  const [date, setDate] = useState(new Date());
  const changeMonth = (offset) =>
    setDate((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + offset);
      return newDate;
    });
  const month = date.getMonth();
  const year = date.getFullYear();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const renderDays = () => {
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(<div key={`empty-${i}`} className="w-8 h-8"></div>);
    for (let day = 1; day <= daysInMonth; day++) {
      const dateString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isSelected = selectedDates.includes(dateString);
      const isToday = new Date().toDateString() === new Date(year, month, day).toDateString();
      days.push(
        <div
          key={dateString}
          onClick={() => onDateToggle(dateString)}
          className={`w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center rounded-full cursor-pointer transition-all ${
            isSelected ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-gray-100 text-gray-700'
          } ${isToday && !isSelected ? 'ring-2 ring-indigo-200 font-bold' : ''}`}
        >
          {day}
        </div>
      );
    }
    return days;
  };
  return (
    <div className="bg-white border border-gray-200 p-4 rounded-xl">
      <div className="flex justify-between items-center mb-4">
        <button onClick={() => changeMonth(-1)} className="p-1 hover:bg-gray-100 rounded">&lt;</button>
        <h4 className="font-bold text-gray-800">
          {date.toLocaleString('default', { month: 'long' })} {year}
        </h4>
        <button onClick={() => changeMonth(1)} className="p-1 hover:bg-gray-100 rounded">&gt;</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-gray-400 mb-2">
        {dayNames.map((d, i) => (
          <div key={`header-${i}`}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1 place-items-center text-sm">{renderDays()}</div>
    </div>
  );
};

const MyFeedSection = () => {
  const { userId, userProfile, showGlobalMessage } = useContext(AppContext);
  const [feedItems, setFeedItems] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const sentinelRef = useRef(null);
  const generatingRef = useRef(false);

  useEffect(() => {
    if (!userId) return;
    // ASC ordering so new items from infinite-scroll appear at the bottom
    // of the rendered list (where the user is looking), not at the top.
    const q = query(collection(db, `artifacts/${appId}/users/${userId}/feed`), orderBy('timestamp', 'asc'), limit(200));
    return onSnapshot(q, (snapshot) => setFeedItems(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [userId]);

  // Infinite scroll: when sentinel becomes visible and we already have content,
  // auto-fetch another batch of upcoming events. Guarded by generatingRef so we
  // never fire concurrent fetches.
  useEffect(() => {
    if (!sentinelRef.current || feedItems.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !generatingRef.current) {
          generatingRef.current = true;
          generatePersonalSuggestions(false).finally(() => {
            // brief cooldown so a single scroll-to-bottom doesn't spam requests
            setTimeout(() => { generatingRef.current = false; }, 800);
          });
        }
      },
      // Trigger well before the sentinel hits the viewport so the fetch
      // starts while the user is still scrolling through existing cards.
      { rootMargin: '1200px' }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedItems.length, userProfile]);

  const deleteFeedItem = async (itemId) => {
    try {
      await deleteDoc(doc(db, `artifacts/${appId}/users/${userId}/feed/${itemId}`));
      showGlobalMessage('Item dismissed from feed.');
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not delete item.', 'error');
    }
  };

  const generatePersonalSuggestions = async (forToday = false) => {
    if (!geminiApiKey) {
      showGlobalMessage('Gemini API key missing. Set VITE_GEMINI_API_KEY in your environment.', 'error');
      return;
    }
    setIsGenerating(forToday ? 'today' : 'upcoming');
    try {
      const loc = userProfile?.address || 'New York, NY';
      const prefs = userProfile?.preferences?.join(', ') || 'general fun';
      const kidsText = userProfile?.kids?.length ? `Kids ages: ${userProfile.kids.map((k) => k.age).join(',')}` : 'No kids';
      const todsPrefs = userProfile?.timeOfDayPrefs?.length ? userProfile.timeOfDayPrefs.join(', ') : 'any time';
      const dowPrefs = userProfile?.dayOfWeekPrefs?.length ? userProfile.dayOfWeekPrefs.join(', ') : 'any day';
      const today = new Date().toDateString();

      const timeframePrompt = forToday
        ? `events happening strictly TODAY, ${today}, or tonight.`
        : `upcoming events happening within the next 30 days.`;

      const prompt = `Today is ${today}. Find 5 ACTUAL, REAL-WORLD events, pop-ups, festivals, or highly-rated specific venue activities CLOSE TO ${loc} (within ~15 miles / 25 km — prefer the user's own neighborhood and surrounding area, NOT generic city-wide listings) ${timeframePrompt}
Constraints:
- Family situation: ${kidsText}
- Interests/preferences: ${prefs}
- Preferred times of day: ${todsPrefs}
- Preferred days of week: ${dowPrefs}
IMPORTANT:
- Do NOT make up events. Only suggest real events you can verify via web search.
- Ensure event dates are strictly today or in the future.
- For each event, include the OFFICIAL event/venue URL (no aggregator links if avoidable).
- For imageUrl, find a real public image URL (jpg/png/webp) from the event's official website, venue site, or a major publication — verify the URL is reachable. If you can't find one, set imageUrl to null.
- For imageKeywords, provide 3-6 specific visual words that describe what an image of this event would look like (e.g. "WNBA basketball game arena" or "outdoor jazz concert park summer"). NOT the event name — actual visual scene keywords. This is used to generate a topical fallback image.
Return ONLY a JSON array (no prose, no markdown fences) of objects with these keys: title, description, location, date (YYYY-MM-DD HH:MM), url, imageUrl, imageKeywords.`;

      const response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        }),
      });

      if (!response.ok) throw new Error('API call failed');
      const data = await response.json();
      if (!data.candidates) throw new Error('AI returned empty response');
      const suggestions = extractJsonArray(data.candidates[0].content.parts[0].text);
      if (!suggestions) throw new Error('Could not parse suggestions from AI response');
      const batch = writeBatch(db);
      suggestions.forEach((s) =>
        batch.set(doc(collection(db, `artifacts/${appId}/users/${userId}/feed`)), {
          type: 'personalSuggestion',
          data: s,
          timestamp: serverTimestamp(),
        })
      );
      await batch.commit();
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not fetch real events. Try again.', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h2 className="text-xl font-bold text-gray-800">Your Feed</h2>
        <div className="flex gap-2 w-full md:w-auto">
          <button onClick={() => generatePersonalSuggestions(true)} disabled={isGenerating !== false} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-orange-400 to-pink-500 text-white rounded-lg shadow-md hover:shadow-lg transition disabled:opacity-50 font-bold">
            {isGenerating === 'today' ? <SearchIcon className="w-4 h-4 animate-spin" /> : <SparklesIcon className="w-4 h-4" />}
            Ideas for Today
          </button>
          <button onClick={() => generatePersonalSuggestions(false)} disabled={isGenerating !== false} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-lg shadow-md hover:shadow-lg transition disabled:opacity-50 font-bold">
            {isGenerating === 'upcoming' ? <SearchIcon className="w-4 h-4 animate-spin" /> : <CalendarIcon className="w-4 h-4" />}
            Upcoming
          </button>
        </div>
      </div>

      {feedItems.length === 0 ? (
        <div className="text-center py-16 bg-white/50 rounded-2xl border border-dashed border-gray-300">
          <SparklesIcon className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <h3 className="text-lg font-bold text-gray-600">Your feed is empty</h3>
          <p className="text-sm text-gray-500 max-w-sm mx-auto mt-2">Click one of the buttons above to let AI find real-world events happening around you.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {feedItems.map((item) => (
            <FeedCard key={item.id} item={item} onDelete={() => deleteFeedItem(item.id)} />
          ))}
          {/* Infinite scroll sentinel: when visible, fetch more upcoming events */}
          <div ref={sentinelRef} className="h-12 flex items-center justify-center text-sm text-gray-400">
            {isGenerating === 'upcoming' ? (
              <span className="flex items-center gap-2">
                <SearchIcon className="w-4 h-4 animate-spin" /> Finding more events…
              </span>
            ) : (
              'Scroll for more'
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const FeedCard = ({ item, onDelete }) => {
  const { googleAccessToken, showGlobalMessage } = useContext(AppContext);
  const { data, type } = item;
  const isInvite = type === 'groupProposal';
  const bgColor = isInvite ? 'bg-amber-50 border-amber-100' : 'bg-white border-gray-100';
  const imageSrc = useEventImage(data);

  if (type === 'groupJoin')
    return (
      <div className="p-4 rounded-xl bg-purple-50 text-purple-900 flex items-center gap-3 border border-purple-100 shadow-sm relative group">
        <UsersIcon className="w-5 h-5" /> You joined <strong>{data.groupName}</strong>
        <button onClick={onDelete} className="absolute right-4 opacity-0 group-hover:opacity-100 text-purple-300 hover:text-purple-600 transition">
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>
    );

  if (type === 'groupSuggestion')
    return (
      <div className="p-4 rounded-xl bg-green-50 text-green-900 flex items-center gap-3 border border-green-100 shadow-sm relative group">
        <LightbulbIcon className="w-5 h-5" /> New ideas available for <strong>{data.groupName}</strong>
        <button onClick={onDelete} className="absolute right-4 opacity-0 group-hover:opacity-100 text-green-300 hover:text-green-600 transition">
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>
    );

  const handleCalendarClick = async () => {
    if (googleAccessToken) {
      await addToGoogleCalendar(data, googleAccessToken, showGlobalMessage);
    } else {
      generateICSFile(data);
    }
  };

  return (
    <div className={`p-5 rounded-xl border ${bgColor} shadow-sm transition hover:shadow-md relative group overflow-hidden`}>
      <button onClick={onDelete} className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 bg-white/80 p-1 rounded-full transition" title="Dismiss">
        <TrashIcon className="w-5 h-5" />
      </button>

      <div className="w-full h-48 mb-4 rounded-xl overflow-hidden bg-gray-100 -mt-2">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={data.title}
            className="w-full h-full object-cover"
            onError={(e) => {
              const stage = e.target.dataset.fallbackStage || '0';
              if (stage === '0') {
                e.target.dataset.fallbackStage = '1';
                e.target.src = pollinationsImage(data.imageKeywords || data.title);
              } else if (stage === '1') {
                e.target.dataset.fallbackStage = '2';
                e.target.src = textPlaceholder(data.title);
              }
            }}
          />
        ) : (
          <div className="w-full h-full animate-pulse bg-gradient-to-br from-indigo-100 to-purple-100" />
        )}
      </div>

      <div className="flex justify-between items-start pr-8">
        <div className="w-full">
          {isInvite && <span className="text-xs font-bold text-amber-600 uppercase tracking-wide mb-1 block">Proposal from {data.proposerName}</span>}
          <h3 className="font-bold text-gray-900 text-xl">{data.title}</h3>
          <p className="text-gray-600 text-sm mt-1 leading-relaxed">{data.description}</p>
          <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500 font-medium">
            <span className="flex items-center gap-1">
              <CalendarIcon className="w-4 h-4" /> {new Date(data.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
            <span className="flex items-center gap-1">
              <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-4 h-4" /> {data.location}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-5 flex gap-3 border-t border-gray-100 pt-4">
        {data.url && (
          <a href={data.url} target="_blank" rel="noopener noreferrer" className="flex-1 text-center text-sm font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 py-2.5 rounded-lg transition flex items-center justify-center gap-1">
            <Icon path="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" className="w-4 h-4" /> More Info
          </a>
        )}
        <button onClick={handleCalendarClick} className="flex-1 text-sm font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 py-2.5 rounded-lg transition flex items-center justify-center gap-1">
          <PlusIcon className="w-4 h-4" /> {googleAccessToken ? 'Save to Google Calendar' : 'Download .ics'}
        </button>
      </div>
    </div>
  );
};

const GroupSection = () => {
  const { userProfile } = useContext(AppContext);
  const [groups, setGroups] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [viewGroup, setViewGroup] = useState(null);

  const groupIdsKey = userProfile?.groupIds?.join(',') || '';

  useEffect(() => {
    if (!userProfile?.groupIds?.length) {
      setGroups([]);
      return;
    }
    const q = query(collection(db, `artifacts/${appId}/public/data/groups`), where('__name__', 'in', userProfile.groupIds));
    return onSnapshot(q, (snap) => setGroups(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [groupIdsKey]);

  if (viewGroup) return <GroupDetailView group={viewGroup} onBack={() => setViewGroup(null)} />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-gray-800">Your Groups</h2>
        <button onClick={() => setShowCreate(true)} className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium shadow-sm hover:bg-indigo-700 transition flex items-center gap-2">
          <PlusIcon /> New Group
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {groups.length === 0 ? (
          <p className="text-gray-500">No groups yet.</p>
        ) : (
          groups.map((g) => (
            <div key={g.id} onClick={() => setViewGroup(g)} className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition cursor-pointer group">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-lg text-gray-900 group-hover:text-indigo-600 transition-colors">{g.name}</h3>
                  <p className="text-sm text-gray-500 mt-1">{g.members?.length || 0} members</p>
                </div>
                <div className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center text-gray-400 group-hover:bg-indigo-50 group-hover:text-indigo-500 transition">
                  <Icon path="M9 5l7 7-7 7" className="w-5 h-5" />
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      {showCreate && <CreateGroupModal onClose={() => setShowCreate(false)} />}
    </div>
  );
};

const CreateGroupModal = ({ onClose }) => {
  const { userId, showGlobalMessage } = useContext(AppContext);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const refDoc = await addDoc(collection(db, `artifacts/${appId}/public/data/groups`), {
        name,
        members: [userId],
        adminId: userId,
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { groupIds: arrayUnion(refDoc.id) });
      showGlobalMessage('Group created!');
      onClose();
    } catch (e) {
      showGlobalMessage('Error creating group', 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal onClose={onClose} title="New Group">
      <div className="space-y-4">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Group Name (e.g. Hiking Buddies)" className="w-full p-3 border rounded-xl" />
        <button onClick={handleCreate} disabled={creating || !name.trim()} className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50">
          {creating ? 'Creating...' : 'Create Group'}
        </button>
      </div>
    </Modal>
  );
};

const GroupDetailView = ({ group, onBack }) => {
  const { userId, showGlobalMessage, getUserNameById } = useContext(AppContext);
  const [members, setMembers] = useState([]);
  const [showInvite, setShowInvite] = useState(false);

  useEffect(() => {
    Promise.all(group.members.map((id) => getUserNameById(id))).then(setMembers);
  }, [group]);

  const handleLeave = async () => {
    if (!window.confirm('Leave this group?')) return;
    try {
      await updateDoc(doc(db, `artifacts/${appId}/public/data/groups`, group.id), { members: arrayRemove(userId) });
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { groupIds: arrayRemove(group.id) });
      onBack();
    } catch (e) {
      showGlobalMessage('Failed to leave group', 'error');
    }
  };

  return (
    <div className="flex flex-col h-[70vh]">
      <div className="flex items-center justify-between mb-4 pb-4 border-b">
        <button onClick={onBack} className="text-gray-500 hover:text-indigo-600 font-medium flex items-center gap-1">
          <Icon path="M15 19l-7-7 7-7" /> Back
        </button>
        <h2 className="text-xl font-bold">{group.name}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowInvite(true)}
            className="text-indigo-500 hover:text-indigo-700 p-2 rounded-full hover:bg-indigo-50 flex items-center gap-1"
            title="Invite people"
          >
            <InviteIcon className="w-5 h-5" />
          </button>
          <button onClick={handleLeave} className="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50" title="Leave group">
            <LeaveIcon />
          </button>
        </div>
      </div>
      {showInvite && <InviteModal group={group} onClose={() => setShowInvite(false)} />}
      <div className="flex-1 overflow-hidden flex flex-col md:flex-row gap-4">
        <div className="flex-1 flex flex-col min-h-0 bg-white rounded-2xl border shadow-sm overflow-hidden">
          <ChatRoom groupId={group.id} />
        </div>
        <div className="w-full md:w-64 space-y-4 overflow-y-auto">
          <div className="bg-gray-50 p-4 rounded-xl">
            <h4 className="font-bold text-gray-700 mb-2 text-sm uppercase">Members</h4>
            <div className="space-y-2">
              {members.map((m, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                  <div className="w-2 h-2 rounded-full bg-green-400"></div>
                  {m}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const ChatRoom = ({ groupId }) => {
  const { userId, userProfile } = useContext(AppContext);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    const q = query(collection(db, `artifacts/${appId}/public/data/groups/${groupId}/messages`), orderBy('timestamp', 'asc'), limit(100));
    return onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    });
  }, [groupId]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    await addDoc(collection(db, `artifacts/${appId}/public/data/groups/${groupId}/messages`), {
      text,
      senderId: userId,
      senderName: userProfile.name,
      photoURL: userProfile.photoURL || null,
      timestamp: serverTimestamp(),
    });
    setText('');
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
        {messages.map((m, i) => {
          const isMe = m.senderId === userId;
          const showHeader = i === 0 || messages[i - 1].senderId !== m.senderId;
          return (
            <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} ${showHeader ? 'mt-4' : 'mt-1'}`}>
              {!isMe && showHeader && <Avatar src={m.photoURL} alt={m.senderName} size="xs" className="w-8 h-8 mr-2 self-end mb-1" />}
              <div className={`max-w-[75%] px-4 py-2 rounded-2xl text-sm ${isMe ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white text-gray-800 shadow-sm rounded-bl-none border border-gray-100'}`}>
                {!isMe && showHeader && <p className="text-xs font-bold text-gray-400 mb-1">{m.senderName}</p>}
                {m.text}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={send} className="p-3 bg-white border-t flex gap-2">
        <input className="flex-1 bg-gray-100 border-0 rounded-full px-4 focus:ring-2 focus:ring-indigo-500" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message..." />
        <button type="submit" className="p-2 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 disabled:opacity-50" disabled={!text.trim()}>
          <SendIcon className="w-5 h-5" />
        </button>
      </form>
    </>
  );
};

const SuggestionSection = () => {
  const { userId, userProfile, showGlobalMessage, googleAccessToken } = useContext(AppContext);
  const [groups, setGroups] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [ideas, setIdeas] = useState([]);
  const [memberSummary, setMemberSummary] = useState(null);

  const groupIdsKey = userProfile?.groupIds?.join(',') || '';

  useEffect(() => {
    if (!userProfile?.groupIds?.length) {
      setGroups([]);
      return;
    }
    const q = query(collection(db, `artifacts/${appId}/public/data/groups`), where('__name__', 'in', userProfile.groupIds));
    return onSnapshot(q, (snap) => setGroups(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [groupIdsKey]);

  // When the user picks a group, pre-load a small summary of members so they
  // can see what data will be mined before clicking "Find Real Events".
  useEffect(() => {
    if (!selectedId) {
      setMemberSummary(null);
      return;
    }
    const group = groups.find((g) => g.id === selectedId);
    if (!group?.members) return;
    let cancelled = false;
    (async () => {
      try {
        const profiles = await Promise.all(
          group.members.map(async (uid) => {
            try {
              const snap = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
              return snap.exists() ? { uid, ...snap.data() } : { uid, name: 'User' };
            } catch {
              return { uid, name: 'User' };
            }
          })
        );
        if (cancelled) return;
        setMemberSummary({
          count: profiles.length,
          names: profiles.map((p) => p.name?.split(' ')[0] || 'User'),
          hasAvailability: profiles.some((p) => p.freeSlots?.length),
          prefs: [...new Set(profiles.flatMap((p) => p.preferences || []))].slice(0, 12),
        });
      } catch (e) {
        if (!cancelled) setMemberSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, groups]);

  const generate = async () => {
    if (!geminiApiKey) {
      showGlobalMessage('Gemini API key missing. Set VITE_GEMINI_API_KEY in your environment.', 'error');
      return;
    }
    setGenerating(true);
    try {
      const group = groups.find((g) => g.id === selectedId);

      // Fetch every member's profile to aggregate the group's collective
      // interests, availability, and constraints. Suggester's profile acts
      // as the location anchor since we don't yet have a group-level locale.
      const memberProfiles = await Promise.all(
        group.members.map(async (uid) => {
          try {
            const snap = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
            return snap.exists() ? { uid, ...snap.data() } : { uid };
          } catch {
            return { uid };
          }
        })
      );

      // Aggregate
      const allPrefs = [...new Set(memberProfiles.flatMap((p) => p.preferences || []))];
      const allTimeOfDay = [...new Set(memberProfiles.flatMap((p) => p.timeOfDayPrefs || []))];
      const allDayOfWeek = [...new Set(memberProfiles.flatMap((p) => p.dayOfWeekPrefs || []))];
      const allKids = memberProfiles.flatMap((p) => p.kids || []);
      const loc = userProfile?.address || memberProfiles.find((p) => p.address)?.address || 'New York';

      // Each member's free time blocks, capped to the next 14 entries each
      // so we don't blow the prompt budget on very busy users.
      const availability = memberProfiles
        .filter((p) => p.freeSlots?.length)
        .map((p) => ({
          name: p.name?.split(' ')[0] || 'Member',
          slots: p.freeSlots.slice(0, 14),
        }));

      const today = new Date().toDateString();

      const prompt = `Today is ${today}. You're recommending events for a group of ${memberProfiles.length} friends called "${group.name}" who want to hang out together.

GROUP CONTEXT:
- Combined interests across all members: ${allPrefs.length ? allPrefs.join(', ') : 'general fun'}
- Preferred times of day (union across members): ${allTimeOfDay.length ? allTimeOfDay.join(', ') : 'any time'}
- Preferred days of week (union across members): ${allDayOfWeek.length ? allDayOfWeek.join(', ') : 'any day'}
- Family situation: ${allKids.length ? `Group includes children ages ${allKids.map((k) => k.age).join(', ')} — prefer family-friendly options.` : 'No children — adult-friendly options are fine.'}
- Anchor location: ${loc} (events must be within ~15 miles / 25 km of here)

MEMBER AVAILABILITY (free time blocks, next 30 days):
${
  availability.length
    ? availability.map((m) => `- ${m.name}: ${m.slots.map((s) => `${s.date} ${s.start}-${s.end}`).join('; ')}`).join('\n')
    : '(No members have synced calendars yet — pick popular times: Friday/Saturday evenings and weekend afternoons.)'
}

YOUR TASK:
Search the web for 6 ACTUAL, REAL-WORLD events happening near ${loc} in the next 30 days. PRIORITIZE events whose date/time overlaps with the most members' free blocks above. If no member availability is provided, prioritize Friday/Saturday evenings and weekend afternoons.

IMPORTANT:
- Do NOT make up events. Only suggest real events you can verify via web search.
- Ensure event dates are strictly today or in the future.
- Include the OFFICIAL event/venue URL.
- For imageUrl, find a real public image URL from the event's website, venue, or a major publication. If you can't find one, set imageUrl to null.
- For imageKeywords, provide 3-6 specific visual scene words (e.g. "WNBA basketball arena game"). Not the event name.
Return ONLY a JSON array (no prose, no markdown fences) of objects with keys: title, description, location, date (YYYY-MM-DD HH:MM), url, imageUrl, imageKeywords.`;

      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        }),
      });
      const data = await res.json();
      if (!data.candidates) throw new Error('AI returned empty response');
      const parsed = extractJsonArray(data.candidates[0].content.parts[0].text);
      if (!parsed) throw new Error('Could not parse ideas from AI response');
      setIdeas(parsed);
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not fetch real events. Try again.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleProposeSuggestion = async (suggestion) => {
    try {
      const group = groups.find((g) => g.id === selectedId);
      const proposalData = { ...suggestion, proposerId: userId, proposerName: userProfile.name, groupId: group.id, groupName: group.name };
      const batch = writeBatch(db);
      group.members.forEach((memberId) => {
        batch.set(doc(collection(db, `artifacts/${appId}/users/${memberId}/feed`)), {
          type: 'groupProposal',
          data: proposalData,
          timestamp: serverTimestamp(),
        });
      });
      await batch.commit();
      showGlobalMessage(`Proposed to ${group.name}!`, 'success');
    } catch (error) {
      showGlobalMessage('Failed to propose suggestion.', 'error');
    }
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row gap-4 mb-4 bg-indigo-50 p-6 rounded-2xl items-end">
        <div className="flex-1 w-full">
          <label className="block text-sm font-bold text-indigo-900 mb-2">Select a Group</label>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="w-full p-3 rounded-xl border-indigo-200 focus:ring-indigo-500 bg-white">
            <option value="">Choose a group...</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <button onClick={generate} disabled={!selectedId || generating} className="w-full md:w-auto bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold shadow-lg hover:shadow-xl transition disabled:opacity-50 flex items-center justify-center gap-2">
          {generating ? <SearchIcon className="w-5 h-5 animate-spin" /> : <SparklesIcon className="w-5 h-5" />}
          {generating ? 'Searching web...' : 'Find Real Events'}
        </button>
      </div>

      {memberSummary && (
        <div className="mb-8 bg-white border border-indigo-100 rounded-2xl p-4 text-sm text-gray-700">
          <p className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-indigo-500" />
            Finding events for {memberSummary.count} member{memberSummary.count === 1 ? '' : 's'}: {memberSummary.names.join(', ')}
          </p>
          {memberSummary.prefs.length > 0 ? (
            <p className="text-xs text-gray-500 mt-1">
              <span className="font-medium">Combined interests:</span> {memberSummary.prefs.join(', ')}
            </p>
          ) : (
            <p className="text-xs text-gray-400 mt-1 italic">No interests captured yet — ideas will be more relevant once members fill in their profiles.</p>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            <span className="font-medium">Calendar mining:</span>{' '}
            {memberSummary.hasAvailability ? 'At least one member has synced free time — we\'ll prefer slots that overlap.' : 'No members have synced calendars yet.'}
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {ideas.map((idea, i) => (
          <SuggestionCard key={i} idea={idea} onPropose={handleProposeSuggestion} googleAccessToken={googleAccessToken} showGlobalMessage={showGlobalMessage} />
        ))}
      </div>
    </div>
  );
};

const SuggestionCard = ({ idea, onPropose, googleAccessToken, showGlobalMessage }) => {
  const imageSrc = useEventImage(idea);
  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col hover:-translate-y-1 transition duration-300">
      <div className="w-full h-32 mb-4 rounded-xl overflow-hidden bg-gray-100 -mt-2">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={idea.title}
            className="w-full h-full object-cover"
            onError={(e) => {
              const stage = e.target.dataset.fallbackStage || '0';
              if (stage === '0') {
                e.target.dataset.fallbackStage = '1';
                e.target.src = pollinationsImage(idea.imageKeywords || idea.title);
              } else if (stage === '1') {
                e.target.dataset.fallbackStage = '2';
                e.target.src = textPlaceholder(idea.title);
              }
            }}
          />
        ) : (
          <div className="w-full h-full animate-pulse bg-gradient-to-br from-indigo-100 to-purple-100" />
        )}
      </div>
      <h3 className="font-bold text-lg text-gray-800 mb-2">{idea.title}</h3>
      <p className="text-gray-600 text-sm mb-4 flex-1">{idea.description}</p>
      <div className="text-xs text-gray-500 mb-4 space-y-1">
        <p className="flex items-center gap-1">
          <CalendarIcon className="w-3 h-3" /> {new Date(idea.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
        <p className="flex items-center gap-1">
          <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-3 h-3" /> {idea.location}
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t pt-4 mt-auto">
        {idea.url && (
          <a href={idea.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center bg-blue-50 text-blue-600 text-sm font-bold p-2.5 rounded-lg hover:bg-blue-100 transition" title="More Info">
            <Icon path="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" className="w-4 h-4 mr-1" /> Info / Tickets
          </a>
        )}
        <div className="flex gap-2">
          <button onClick={() => onPropose(idea)} className="flex-1 bg-indigo-50 text-indigo-600 text-sm font-bold py-2.5 rounded-lg hover:bg-indigo-100 transition">
            Propose
          </button>
          <button
            onClick={async () => {
              if (googleAccessToken) await addToGoogleCalendar(idea, googleAccessToken, showGlobalMessage);
              else generateICSFile(idea);
            }}
            className="flex-1 bg-gray-50 text-gray-700 text-sm font-bold py-2.5 rounded-lg hover:bg-gray-100 transition"
          >
            Calendar
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Auth Screen ---
const AuthScreen = () => {
  const { setGoogleAccessToken } = useContext(AppContext);

  const handleGoogleSignIn = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/calendar.events');
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) setGoogleAccessToken(credential.accessToken);
    } catch (error) {
      console.error('Google sign-in failed:', error);
    }
  };

  // Apple sign-in is disabled until we complete Apple Developer setup
  // (Services ID, signing key, domain verification). The button remains
  // visible but disabled so the UI shows the future option without
  // surprising users with an error when they click.
  const handleAppleSignIn = () => {};

  const handleAnonSignIn = async () => {
    try {
      await signInAnonymously(auth);
    } catch (error) {
      console.error('Anonymous sign-in failed:', error);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-4">
      <div className="bg-white/90 backdrop-blur-xl p-8 rounded-3xl shadow-2xl w-full max-w-md text-center">
        <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-6 text-indigo-600">
          <UsersIcon className="w-10 h-10" />
        </div>
        <h1 className="text-4xl font-black text-gray-900 mb-2">Hangouts</h1>
        <p className="text-gray-500 mb-8">Effortless social planning powered by AI &amp; Live Search.</p>
        <div className="space-y-3">
          <button onClick={handleGoogleSignIn} className="w-full py-3 px-4 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 font-bold text-gray-700 flex items-center justify-center gap-3 transition">
            <GoogleIcon /> Continue with Google
          </button>
          <button
            onClick={handleAppleSignIn}
            disabled
            title="Apple sign-in coming soon"
            className="w-full py-3 px-4 bg-gray-100 text-gray-400 rounded-xl font-bold flex items-center justify-center gap-3 cursor-not-allowed border border-gray-200"
          >
            <AppleIcon /> Continue with Apple
            <span className="text-xs font-medium ml-1 px-2 py-0.5 bg-gray-200 text-gray-500 rounded-full">Soon</span>
          </button>
          <button onClick={handleAnonSignIn} className="text-sm text-gray-400 hover:text-indigo-600 font-medium mt-4">
            Skip for now (Anonymous)
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Group Invites ---
const buildInviteUrl = (groupId) => {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/?join=${encodeURIComponent(groupId)}`;
};

const InviteModal = ({ group, onClose }) => {
  const { showGlobalMessage } = useContext(AppContext);
  const inviteUrl = buildInviteUrl(group.id);
  const [emails, setEmails] = useState('');
  const [sending, setSending] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      showGlobalMessage('Link copied to clipboard!');
    } catch {
      showGlobalMessage('Copy failed — select the link and copy manually.', 'error');
    }
  };

  const share = async () => {
    if (!navigator.share) return copy();
    try {
      await navigator.share({
        title: `Join "${group.name}" on Hangouts`,
        text: `Join "${group.name}" on Hangouts — passcode is hangouts2026`,
        url: inviteUrl,
      });
    } catch {
      // user cancelled — no-op
    }
  };

  const sendEmails = async () => {
    const list = emails
      .split(/[,\s\n]+/)
      .map((s) => s.trim())
      .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (list.length === 0) {
      showGlobalMessage('No valid email addresses to send.', 'error');
      return;
    }
    if (!FEEDBACK_KEY) {
      showGlobalMessage('Email sending not configured (missing VITE_FEEDBACK_KEY).', 'error');
      return;
    }
    setSending(true);
    let ok = 0;
    for (const addr of list) {
      try {
        await fetch('https://api.web3forms.com/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            access_key: FEEDBACK_KEY,
            subject: `You're invited to join "${group.name}" on Hangouts`,
            from_name: 'Hangouts',
            email: addr,
            message: `You've been invited to join the group "${group.name}" on Hangouts.\n\nClick to join: ${inviteUrl}\n\nFirst time? You'll be asked for a passcode — it's: hangouts2026`,
          }),
        });
        ok += 1;
      } catch (e) {
        console.warn('Invite email failed for', addr, e);
      }
    }
    setSending(false);
    setEmails('');
    showGlobalMessage(`Sent ${ok} of ${list.length} invites.`, ok === list.length ? 'success' : 'error');
  };

  return (
    <Modal onClose={onClose} title={`Invite to "${group.name}"`}>
      <div className="space-y-6">
        <div>
          <label className="block text-xs font-semibold uppercase text-gray-500 mb-2">Shareable link</label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={inviteUrl}
              onFocus={(e) => e.target.select()}
              className="flex-1 p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-mono"
            />
            <button
              onClick={copy}
              className="px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm flex items-center gap-2 transition"
            >
              <CopyIcon className="w-4 h-4" /> Copy
            </button>
          </div>
          {typeof navigator !== 'undefined' && navigator.share && (
            <button
              onClick={share}
              className="mt-3 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2.5 rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition"
            >
              <ShareIcon className="w-4 h-4" /> Share via…
            </button>
          )}
          <p className="text-xs text-gray-400 mt-2">Anyone with this link who can get past the passcode can join.</p>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase text-gray-500 mb-2 flex items-center gap-2">
            <MailIcon className="w-4 h-4" /> Or email it directly
          </label>
          <textarea
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder="alice@example.com, bob@example.com"
            className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm min-h-20 focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onClick={sendEmails}
            disabled={sending || !emails.trim()}
            className="mt-3 w-full bg-indigo-600 text-white py-2.5 rounded-xl font-bold disabled:opacity-50 hover:bg-indigo-700 transition"
          >
            {sending ? 'Sending…' : 'Send invites'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

const JoinGroupModal = ({ groupId, onClose }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage } = useContext(AppContext);
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, `artifacts/${appId}/public/data/groups`, groupId));
        if (cancelled) return;
        if (!snap.exists()) {
          showGlobalMessage("That group doesn't exist.", 'error');
          onClose();
          return;
        }
        setGroup({ id: snap.id, ...snap.data() });
      } catch (e) {
        showGlobalMessage('Could not load group.', 'error');
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [groupId]);

  const join = async () => {
    setJoining(true);
    try {
      await updateDoc(doc(db, `artifacts/${appId}/public/data/groups`, groupId), { members: arrayUnion(userId) });
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { groupIds: arrayUnion(groupId) });
      // Log it in the user's feed so they see it next time they open the app
      await addDoc(collection(db, `artifacts/${appId}/users/${userId}/feed`), {
        type: 'groupJoin',
        data: { groupName: group.name, groupId },
        timestamp: serverTimestamp(),
      });
      setUserProfile((prev) => ({ ...prev, groupIds: [...(prev?.groupIds || []), groupId] }));
      showGlobalMessage(`Joined "${group.name}"!`);
      onClose();
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not join group. The invite may be invalid.', 'error');
    } finally {
      setJoining(false);
    }
  };

  const alreadyMember = group?.members?.includes(userId);

  return (
    <Modal onClose={onClose} title="Group invitation">
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !group ? null : (
        <div className="space-y-5">
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5 text-center">
            <UsersIcon className="w-10 h-10 mx-auto text-indigo-500 mb-2" />
            <h3 className="text-xl font-bold text-gray-900">{group.name}</h3>
            <p className="text-sm text-gray-500 mt-1">{group.members?.length || 0} member{group.members?.length === 1 ? '' : 's'}</p>
          </div>
          {alreadyMember ? (
            <>
              <p className="text-sm text-gray-600 text-center">You're already a member of this group.</p>
              <button onClick={onClose} className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-bold transition">
                Close
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-600 text-center">
                You've been invited to join <strong>{group.name}</strong> on Hangouts.
              </p>
              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-bold transition">
                  Not now
                </button>
                <button onClick={join} disabled={joining} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-bold disabled:opacity-50 transition">
                  {joining ? 'Joining…' : 'Join group'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
};

// --- Feedback Widget ---
// Floating "Feedback" button in the bottom-right. Submitted feedback is
// stored in Firestore (artifacts/{appId}/public/data/feedback) and, when
// VITE_FEEDBACK_KEY is configured, also emailed to the project owner via
// Web3Forms.
const FEEDBACK_KEY = import.meta.env.VITE_FEEDBACK_KEY || '';

const FeedbackButton = () => {
  const { userId } = useContext(AppContext);
  const [open, setOpen] = useState(false);
  if (!userId) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 bg-indigo-600 text-white pl-4 pr-5 py-3 rounded-full shadow-2xl hover:bg-indigo-700 z-40 flex items-center gap-2 font-medium text-sm transition-transform hover:scale-105"
        title="Send feedback"
      >
        <ChatIcon className="w-5 h-5" />
        Feedback
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
};

const FeedbackModal = ({ onClose }) => {
  const { userId, userProfile, showGlobalMessage } = useContext(AppContext);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitting(true);
    const payload = {
      text: trimmed,
      userId,
      userName: userProfile?.name || 'Anonymous',
      url: typeof window !== 'undefined' ? window.location.pathname : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      timestamp: serverTimestamp(),
    };
    try {
      // 1) Persist to Firestore so the owner has a permanent record.
      await addDoc(collection(db, `artifacts/${appId}/public/data/feedback`), payload);

      // 2) Optionally email the owner via Web3Forms (no signup required to send,
      //    just an access key from the owner's Web3Forms account).
      if (FEEDBACK_KEY) {
        try {
          await fetch('https://api.web3forms.com/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              access_key: FEEDBACK_KEY,
              subject: 'Hangouts feedback',
              from_name: payload.userName,
              message: `${trimmed}\n\n— from ${payload.userName} (uid: ${userId})\nURL: ${payload.url}\nUA: ${payload.userAgent}`,
            }),
          });
        } catch (e) {
          // Email failure is non-fatal — feedback is still saved to Firestore.
          console.warn('Web3Forms email failed:', e);
        }
      }

      showGlobalMessage('Thanks — feedback sent!');
      onClose();
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not send feedback. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Share Feedback">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Notice something broken, an idea for an improvement, or just want to say something nice? Drop it here — it goes straight to the maintainer.
        </p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's working? What's broken? What's missing?"
          className="w-full p-3 border border-gray-200 rounded-xl min-h-32 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition resize-y"
        />
        <button
          onClick={submit}
          disabled={!text.trim() || submitting}
          className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50 hover:bg-indigo-700 transition"
        >
          {submitting ? 'Sending…' : 'Send feedback'}
        </button>
      </div>
    </Modal>
  );
};

// --- Password Gate ---
// A simple shared-passcode wall that fronts the entire app. Useful for
// friends-and-family demos that shouldn't be world-accessible.
// VITE_PASSCODE_HASH should be the lowercase hex SHA-256 of the chosen
// passcode. If the env var is not set, the gate is bypassed (handy for
// local dev). Once unlocked, the result is cached in localStorage so
// returning users skip the prompt.
const PASSCODE_HASH = import.meta.env.VITE_PASSCODE_HASH || '';
const UNLOCK_KEY = 'hangouts_unlocked_v1';

const sha256Hex = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const PasscodeGate = ({ children }) => {
  // No hash configured -> bypass entirely (treat as dev/preview env).
  const [unlocked, setUnlocked] = useState(
    !PASSCODE_HASH || (typeof window !== 'undefined' && window.localStorage.getItem(UNLOCK_KEY) === 'true')
  );
  const [input, setInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  if (unlocked) return children;

  const tryUnlock = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setChecking(true);
    setError('');
    try {
      const entered = await sha256Hex(input.trim());
      if (entered === PASSCODE_HASH.toLowerCase()) {
        window.localStorage.setItem(UNLOCK_KEY, 'true');
        setUnlocked(true);
      } else {
        setError('Incorrect passcode.');
        setInput('');
      }
    } catch {
      setError('Could not verify passcode.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-4">
      <div className="bg-white/95 backdrop-blur-xl p-8 rounded-3xl shadow-2xl w-full max-w-md text-center">
        <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-6 text-indigo-600">
          <Icon path="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" className="w-10 h-10" />
        </div>
        <h1 className="text-3xl font-black text-gray-900 mb-2">Hangouts</h1>
        <p className="text-gray-500 mb-6">Private preview. Enter the passcode to continue.</p>
        <form onSubmit={tryUnlock} className="space-y-3">
          <input
            autoFocus
            type="password"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(''); }}
            placeholder="Passcode"
            className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white text-center transition"
          />
          {error && <p className="text-sm text-red-500 font-medium">{error}</p>}
          <button
            type="submit"
            disabled={!input.trim() || checking}
            className="w-full py-3 px-4 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-bold transition disabled:opacity-50"
          >
            {checking ? 'Checking…' : 'Unlock'}
          </button>
        </form>
        <p className="text-xs text-gray-400 mt-6">Don't have the passcode? Ask Paul.</p>
      </div>
    </div>
  );
};

// --- Main App ---
export default function App() {
  const [userId, setUserId] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [googleAccessToken, setGoogleAccessToken] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [pendingJoinGroupId, setPendingJoinGroupId] = useState(null);
  const [unreadFeedCount, setUnreadFeedCount] = useState(0);
  const seenFeedIdsRef = useRef(null); // null until first snapshot lands

  const showGlobalMessage = useCallback((text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 3000);
  }, []);

  const getUserNameById = useCallback(async (uid) => {
    try {
      const snap = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
      return snap.exists() ? snap.data().name : 'User';
    } catch {
      return 'User';
    }
  }, []);

  // Subscribe to the current user's feed at the top level so we can show
  // a toast when a new group proposal arrives even if the user is on a
  // different tab. The MyFeed tab still has its own subscription for
  // rendering; that's a small duplication but Firestore deduplicates the
  // wire traffic.
  // NOTE: This effect must be declared AFTER `showGlobalMessage` because
  // it appears in the deps array — `const` symbols are in TDZ before
  // their initializer, and an earlier version of this code blanked the
  // whole app with a ReferenceError on first render.
  useEffect(() => {
    if (!userId) {
      seenFeedIdsRef.current = null;
      setUnreadFeedCount(0);
      return;
    }
    const q = query(
      collection(db, `artifacts/${appId}/users/${userId}/feed`),
      orderBy('timestamp', 'desc'),
      limit(30)
    );
    return onSnapshot(q, (snap) => {
      const currentIds = new Set();
      const fresh = [];
      snap.docs.forEach((d) => {
        currentIds.add(d.id);
        if (seenFeedIdsRef.current && !seenFeedIdsRef.current.has(d.id)) {
          fresh.push({ id: d.id, ...d.data() });
        }
      });
      if (seenFeedIdsRef.current === null) {
        seenFeedIdsRef.current = currentIds;
        return;
      }
      seenFeedIdsRef.current = currentIds;
      fresh
        .filter((i) => i.type === 'groupProposal' || i.type === 'groupSuggestion')
        .forEach((i) => {
          const who = i.data?.proposerName || 'Someone';
          const title = i.data?.title || 'a new event';
          const group = i.data?.groupName ? ` (${i.data.groupName})` : '';
          showGlobalMessage(`${who} proposed: "${title}"${group}`);
        });
      if (fresh.length) setUnreadFeedCount((n) => n + fresh.length);
    });
  }, [userId, showGlobalMessage]);

  // Parse `?join={groupId}` once on first load. Stash the group id; we'll
  // surface the join modal as soon as the user is signed in.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join');
    if (join) {
      setPendingJoinGroupId(join);
      params.delete('join');
      const query = params.toString();
      const newUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u) {
        setUserId(u.uid);
        const profileRef = doc(db, `artifacts/${appId}/users/${u.uid}/profiles`, 'myProfile');
        onSnapshot(profileRef, (s) => {
          if (s.exists()) {
            setUserProfile(s.data());
          } else {
            const newProfile = { name: u.displayName || 'User', createdAt: serverTimestamp(), photoURL: u.photoURL };
            setDoc(profileRef, newProfile);
            setUserProfile(newProfile);
          }
          setLoading(false);
        });
      } else {
        setUserId(null);
        setLoading(false);
      }
    });
    const timer = setTimeout(() => setLoading(false), 3000);
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, []);

  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-indigo-50">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
      </div>
    );

  return (
    <PasscodeGate>
      <AppContext.Provider
        value={{
          userId,
          userProfile,
          setUserProfile,
          showGlobalMessage,
          setShowProfileModal,
          setShowSettingsModal,
          setShowAboutModal,
          getUserNameById,
          googleAccessToken,
          setGoogleAccessToken,
          unreadFeedCount,
          markFeedRead: () => setUnreadFeedCount(0),
        }}
      >
        {!userId ? (
          <AuthScreen />
        ) : (
        <div className="min-h-screen bg-[#F3F4F6] text-gray-900 font-sans p-4 md:p-8">
          <Header />
          {msg && (
            <div className={`fixed top-6 right-6 px-6 py-3 rounded-xl shadow-2xl text-white font-bold z-[100] animate-fade-in ${msg.type === 'error' ? 'bg-red-500' : 'bg-emerald-500'}`}>
              {msg.text}
            </div>
          )}
          <MainContent />
          {showProfileModal && <ProfileModal onClose={() => setShowProfileModal(false)} />}
          {showSettingsModal && <SettingsModal onClose={() => setShowSettingsModal(false)} />}
          {showAboutModal && <AboutModal onClose={() => setShowAboutModal(false)} />}
          {pendingJoinGroupId && (
            <JoinGroupModal groupId={pendingJoinGroupId} onClose={() => setPendingJoinGroupId(null)} />
          )}
          <FeedbackButton />
        </div>
        )}
      </AppContext.Provider>
    </PasscodeGate>
  );
}
