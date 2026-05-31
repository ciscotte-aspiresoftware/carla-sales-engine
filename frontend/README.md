# SDR Engine — Frontend

Next.js 16 (App Router) UI for the SDR Engine. Talks to the FastAPI backend on
`http://localhost:8000`. Pure presentation + thin API client — all business
logic, AI calls, and persistence live in the Python backend.

For the **full project README, install instructions, and architecture
overview**, see [`../README.md`](../README.md).

---

## Quick start

From the repo root (one-time):

```bash
# macOS / Linux
./install.sh

# Windows
.\install.ps1     # PowerShell
install.bat       # cmd
```

Then either run `./start.sh` / `start.bat` from the root, or just the
frontend in isolation:

```bash
cd frontend
npm run dev
```

Open <http://localhost:3000>.

---

## Stack

- **Next.js 16** — App Router
- **React 19**
- **TypeScript** — strict mode
- **Tailwind CSS** + **shadcn/ui** components
- **lucide-react** for icons

## Layout

```text
frontend/
├── app/                  # App Router pages
│   ├── prospects/        # Prospect list, detail, discovery flow
│   ├── campaigns/        # Campaign management + 3-step builder
│   ├── optimize/         # Revenue Optimizer — KPIs, heatmap, AI recs
│   ├── packs/            # Pack Explorer — vertical/vendor/product/regional
│   ├── activity/         # Real activity feed
│   └── dashboard/        # KPI dashboard
├── components/           # Shared React UI (shadcn/ui based)
├── lib/
│   ├── api.ts            # All HTTP calls to the backend
│   ├── types.ts          # TypeScript interfaces
│   └── vertical-context.tsx   # Active vertical state (sidebar follows it)
└── public/
```

## Common scripts

```bash
npm run dev      # Start dev server (http://localhost:3000)
npm run build    # Production build
npm run start    # Run the production build
npm run lint     # ESLint
```

## Backend dependency

The UI is useless without the backend running on `:8000`. If you see network
errors in the browser console, confirm the backend is up:

```bash
curl http://localhost:8000/health
```

If the port differs, set `NEXT_PUBLIC_API_URL` in `frontend/.env.local`
before `npm run dev` (e.g. `NEXT_PUBLIC_API_URL=http://localhost:9000/api/v1`).

## Notes

- This project pins a specific Next.js build — see [`AGENTS.md`](AGENTS.md)
  before assuming behaviour from older Next.js versions.
- `node_modules/`, `.next/`, `*.tsbuildinfo`, and `next-env.d.ts` are
  gitignored at the repo root.
