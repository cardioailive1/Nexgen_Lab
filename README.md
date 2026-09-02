# Corverxis Technologies Platform

Full-stack deployment — **CorverxisONE** + **Corverxis Vision** + **PostgreSQL via Prisma**.

## URLs after deployment

| URL | What opens |
|-----|-----------|
| `https://your-app.onrender.com/` | CorverxisONE — full enterprise platform |
| `https://your-app.onrender.com/vision` | Corverxis Vision — standalone machine vision |
| `https://your-app.onrender.com/api/health` | Health check (DB status included) |
| `https://your-app.onrender.com/api/sensors` | Live sensor data from PostgreSQL |
| `https://your-app.onrender.com/api/vision/stats` | Vision session stats from DB |
| `wss://your-app.onrender.com/ws/vision` | Live vision WebSocket |
| `wss://your-app.onrender.com/ws/sensors` | Live sensor WebSocket |

## Deploy to Render.com

1. Extract this zip and push to a **new GitHub repo**
2. Go to **render.com → New → Web Service**
3. Connect your GitHub repo
4. Render reads `render.yaml` automatically — it creates:
   - A **PostgreSQL database** (free tier)
   - A **Node.js web service** connected to it
5. Click **Deploy** — build runs:
   - `npm install`
   - `npx prisma generate`
   - `npx prisma db push` — creates all tables
   - `npx prisma db seed` — seeds demo org, 32 sensors, vision jobs
6. Done in ~3 minutes

## Project structure

```
corverxis-platform/
├── prisma/
│   ├── schema.prisma     ← Full DB schema (users, sensors, vision, audit)
│   └── seed.js           ← Demo data: org, 32 sensors across 8 verticals, vision jobs
├── public/
│   ├── corverxis-one.html     ← CorverxisONE platform
│   └── corverxis-vision.html  ← Corverxis Vision platform
├── src/
│   ├── server.js         ← Express + WebSocket + full Prisma API
│   └── prisma.js         ← Prisma client singleton
├── package.json
├── render.yaml           ← Render config: web service + PostgreSQL DB
└── README.md
```

## Environment variables (set in Render dashboard)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Auto-set by Render from the PostgreSQL database |
| `ADMIN_EMAIL` | Email for the seeded Super Admin account |
| `NODE_ENV` | Set to `production` by Render |

## Local development

```bash
# 1. Create a local .env file
echo 'DATABASE_URL="postgresql://user:pass@localhost:5432/corverxis"' > .env

# 2. Install and set up DB
npm install
npx prisma generate
npx prisma db push
npx prisma db seed

# 3. Start server
npm start
# → http://localhost:3000          (CorverxisONE)
# → http://localhost:3000/vision   (Corverxis Vision)
```

## API endpoints

### Sensors
- `GET  /api/sensors` — all sensors with latest reading and status
- `POST /api/sensors/:id/reading` — `{ value, quality }` — saves reading, auto-creates alert if threshold breached

### Vision
- `GET  /api/vision/jobs` — list inspection jobs
- `GET  /api/vision/stats` — current session stats
- `POST /api/vision/result` — `{ jobId, result, confidence, defectCount, defectTypes, cycleMs }`

### Users
- `POST /api/register` — register user or org
- `GET  /api/admin/users?filter=pending` — list pending/all users
- `PATCH /api/admin/users` — `{ userId, action: "approve"|"reject", role }`

### Health
- `GET /api/health` — platform + DB status
