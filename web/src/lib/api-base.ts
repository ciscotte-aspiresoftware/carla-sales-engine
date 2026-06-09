// Base URL for the Atlas backend.
//
// Empty in local dev → calls stay relative (`/api/...`, `/socket.io`) and the
// Vite dev server proxies them to localhost:3001 (see vite.config.ts).
//
// In a deployed frontend (Netlify/Vercel) there's no same-origin backend, so
// set VITE_API_URL at build time to the backend's public URL, e.g.
//   VITE_API_URL=https://atlas-api-xxxx.onrender.com
// Every fetch + the Socket.IO connection prefixes this.
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
