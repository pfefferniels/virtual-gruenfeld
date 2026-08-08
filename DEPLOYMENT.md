# Deploying the AI teacher

The public app at [play.welte225.org](https://play.welte225.org) currently ships **without**
any AI. It matches your playing, diffs it against Grünfeld and plays the exaggerated
counter-performance — but nobody talks, because the teacher is a Node service that has never
been deployed and `VITE_TEACHER_URL` has never been set.

This document is the whole path from that state to a talking teacher. It is one sitting.

---

## Why not a Cloudflare Worker

The obvious symmetry — the client is on Cloudflare Pages, so put the teacher on a Worker —
does not survive contact with the code. The teacher service:

- **reads the corpus off disk** at startup (`client/public/info.json`, `assets/all/performance.mpm`,
  ~320 kB parsed into 158 argumentations, see `src/corpus/index.ts`);
- **writes session memory to disk** (`data/sessions/*.json`, see `src/sessions/store.ts`);
- **keeps per-process caches** — the parsed corpus, the byte-stable prompt variants, the
  ElevenLabs cue-audio map — all of which assume a long-lived process, and all of which are
  what make the prompt prefix cacheable and the latency numbers in MODERNIZATION.md real.

Porting that to a Worker means bundling the corpus as an asset, moving sessions to KV or D1,
and giving up the process-lifetime caches. That is a project, not a deployment step.

Meanwhile you already run a host that serves the Java MPM renderer at `api.welte225.org`.
It has a disk and a process supervisor. **Put the teacher there.** The rest of this document
assumes that host.

---

## 1. Environment variables

The teacher reads all of these from the process environment (`src/server.ts` loads a `.env`
file via `dotenv`, so either works).

| Variable | Required | Default | What it does |
|---|---|---|---|
| `OPENAI_API_KEY` | **yes** | — | The teacher's thinking. Without it every request 500s. |
| `ELEVENLABS_API_KEY` | no | — | The teacher's voice. Without it answers still come back as text (`src/routes/teacherAsk.ts` degrades deliberately). |
| `ELEVENLABS_VOICE_ID` | no | `a4oYSRgmiY0auDgVfso5` | Which voice. Take path and answer path share it, so the student hears one teacher. |
| `TEACHER_CORS_ORIGIN` | **yes in production** | localhost only | Comma-separated list of browser origins allowed to call this server. See §3. |
| `PORT` | no | `3002` | Where the Node process listens. Behind the proxy this stays on loopback. |
| `SESSIONS_DIR` | no | `data/sessions` | Where per-student lesson history is written. See §5. |
| `OUTPUT_LANGUAGE` | no | `German` | The language the teacher speaks and writes. |
| `OPENAI_CUE_MODEL_REALTIME` | no | `gpt-5.4-mini` | Realtime tier — speaks over live playback, so latency rules. |
| `OPENAI_CUE_MODEL_BALANCED` | no | `gpt-5.6-terra` | Balanced tier. |
| `OPENAI_CUE_MODEL_STUDIO` | no | `gpt-5.6-terra` | Studio tier — same model, deeper corpus (see `CORPUS_DEPTH` in `src/config.ts`). |
| `OPENAI_CUE_MODEL` | no | — | Sets all three tiers at once; each specific variable above wins over it. |
| `OPENAI_PROFILE_MODEL` | no | `gpt-5.4-mini` | The student-profile side-channel, which runs *after* the student has been answered. |
| `ELEVENLABS_MODEL_ID` | no | `eleven_v3` | Take-path voice. **Leave this alone** — v3 is the only model that returns the character timestamps the cue scheduling slices (`src/tts/synthesizeWithTimestamps.ts`). |
| `ELEVENLABS_ASK_MODEL_ID` | no | `eleven_turbo_v2_5` | Answer-path voice. See §6. |
| `CORPUS_INFO_JSON` / `CORPUS_REFERENCE_MPM` | no | found relative to the repo | Absolute paths to the corpus files, if you ever split them from the checkout. |

Never commit any of these. `.env` is gitignored; `.env.example` lists the shape.

---

## 2. Build and run the service

The teacher process never imports `mpm-ts` or `mpmify` — but they are `file:../` dependencies
of the root `package.json` (the *client* build needs them), so `npm ci` wants them on disk.
Clone all three side by side, exactly as `.github/workflows/deploy.yml` does:

```bash
cd /srv
git clone https://github.com/pfefferniels/mpm-ts.git
git clone https://github.com/pfefferniels/mpmify.git
git clone https://github.com/pfefferniels/virtual-gruenfeld.git

cd /srv/virtual-gruenfeld
npm ci
npm run build:server        # tsc -> dist/
```

The checkout must stay in place: the corpus is loaded from `client/public/info.json` and
`assets/all/performance.mpm` relative to it (`findRepoRoot()` walks up from `dist/corpus/`).
Deploying `dist/` alone will not start.

Smoke-test it before wiring anything up:

```bash
OPENAI_API_KEY=sk-... node dist/server.js
# in another shell:
curl -s localhost:3002/health                                    # {"ok":true}
curl -s -X POST localhost:3002/teacher-stream -d '{}' \
     -H 'Content-Type: application/json'                          # 400 + an error message
```

A 400 on the empty body is the healthy answer — it is exactly what the client's
`probeTeacherService()` looks for.

### systemd unit

`/etc/systemd/system/vg-teacher.service`:

```ini
[Unit]
Description=Virtual Grünfeld AI teacher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vgteacher
WorkingDirectory=/srv/virtual-gruenfeld
EnvironmentFile=/etc/vg-teacher.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5

# The service needs to write only its session directory.
StateDirectory=vg-teacher
ProtectSystem=strict
ReadWritePaths=/var/lib/vg-teacher
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`/etc/vg-teacher.env` (mode `0600`, owned by root):

```
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
TEACHER_CORS_ORIGIN=https://play.welte225.org
SESSIONS_DIR=/var/lib/vg-teacher/sessions
PORT=3002
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vg-teacher
journalctl -u vg-teacher -f
```

On startup the log prints the port and the CORS setting, which is the fastest way to catch a
missing `TEACHER_CORS_ORIGIN`.

---

## 3. CORS

The client is on `play.welte225.org` and the teacher is on `api.welte225.org` — a
cross-origin request, so the teacher must name the client explicitly.

`src/cors.ts` decides this:

- **`TEACHER_CORS_ORIGIN` unset** → any `localhost` / `127.0.0.1` origin on any port, and
  nothing else. This is what makes `npm run dev` need no configuration.
- **set** → exactly the listed origins (comma-separated, trailing slashes forgiven).
  Setting it *ends* the localhost allowance, so a production box does not also accept a
  developer's laptop.
- Requests with no `Origin` header (curl, health checks, the smoke script) are never blocked —
  they are not what CORS protects against.

So in production: `TEACHER_CORS_ORIGIN=https://play.welte225.org`. Add a second origin with
a comma if you run a staging Pages deployment.

---

## 4. Reverse proxy and TLS

Two shapes work. **Option A is the one to pick** unless you have a reason not to — it needs no
path rewriting, which is where this kind of setup usually goes wrong.

### Option A — its own subdomain (recommended)

Point `teacher.welte225.org` at the host, then:

```caddyfile
teacher.welte225.org {
    reverse_proxy 127.0.0.1:3002
}
```

nginx equivalent (with certbot managing the certificate):

```nginx
server {
    listen 443 ssl;
    server_name teacher.welte225.org;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # A studio-tier take can think for a few seconds before it answers.
        proxy_read_timeout 120s;
    }
}
```

Then `VITE_TEACHER_URL=https://teacher.welte225.org`.

### Option B — a path under the existing api host

No new DNS record or certificate, but the prefix must be **stripped** before it reaches Node,
which serves `/teacher-stream` and `/teacher-ask` at its root:

```caddyfile
api.welte225.org {
    handle_path /teacher/* {          # handle_path strips the prefix; `handle` would not
        reverse_proxy 127.0.0.1:3002
    }
    handle {
        reverse_proxy 127.0.0.1:8080  # the existing Java renderer
    }
}
```

nginx — the trailing slash on `proxy_pass` is what does the stripping, and dropping it is the
classic way to get 404s here:

```nginx
location /teacher/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

Then `VITE_TEACHER_URL=https://api.welte225.org/teacher`.

Verify from outside the box before moving on:

```bash
curl -s https://teacher.welte225.org/health     # or .../teacher/health
```

Request bodies can reach ~1 MB (a 30-second spoken question, base64). Express accepts 10 MB;
make sure the proxy does too (nginx defaults to 1 MB — set `client_max_body_size 12m;`).

---

## 5. Session memory on disk

`SESSIONS_DIR` holds one JSON file per lesson: the take history the teacher back-references
("noch immer zu rasch") and the student profile. Point it somewhere that survives a restart —
the systemd unit above uses `/var/lib/vg-teacher/sessions`.

Two things to know:

- **Pruning happens once per process start.** Sessions older than 30 days are deleted the
  first time the store is read, and never again while the process lives
  (`src/sessions/store.ts`, `loaded()`). A server that runs for months keeps writing new files
  and only sweeps them at restart. It is bounded per session (50 takes, 20 questions), so this
  is a slow leak of small files, not a risk — but if the box never restarts, restart it
  occasionally, or add a `systemd` timer that removes `*.json` older than 30 days.
- **A page reload starts a new lesson.** The session id lives in a module variable
  (`client/src/session.ts`), deliberately: a new visitor should not inherit the last one's
  history. Files therefore accumulate roughly one per page load that produced a take.

---

## 6. The answer voice

Measured 2026-08-08 on a 314-character German answer. First pass, 3 runs per model, total
wall-clock:

| Model | Median | Audio produced |
|---|---|---|
| `eleven_turbo_v2_5` | 650 ms | 18.1 s |
| `eleven_flash_v2_5` | 725 ms | 16.3 s |
| `eleven_multilingual_v2` | 3134 ms | — |
| `eleven_v3` | 10240 ms | 24.6 s |

Those runs happened on an unreliable connection, so the two finalists were re-measured properly:
**interleaved** A/B over 4 rounds (alternating which model goes first, so drift in conditions
hits both equally), timing **to response headers** so the server's generation time is separated
from body transfer:

| Model | Generation (to headers) | Spread | Transfer (median) |
|---|---|---|---|
| `eleven_turbo_v2_5` | **796 ms** (618 / 758 / 834, plus a 1940 ms first call) | 3.1x | 670 ms |
| `eleven_v3` | **9667 ms** (8905–10247) | **1.15x** | 568 ms |

This is the more trustworthy read, and it says the same thing: **12x on medians, and 4.6x
comparing v3's fastest run against turbo's slowest.** The network's unreliability shows up
exactly where you would expect — in the transfer column, which swung 18.6x for v3 including one
6.6 s outlier — and nowhere near enough to touch the verdict. v3's generation time was the
single most stable number in the whole exercise: four calls, all within 1.15x, all around ten
seconds. That is the model thinking, not the train.

The answer path therefore defaults to **`eleven_turbo_v2_5`**, cutting what was by a wide margin
the slowest leg of a spoken question — the thinking took 1.4–3.7 s and the voice took ten.

The tradeoff is delivery, not intelligibility: transcribing every render back through
`gpt-transcribe` gave a 0% word error rate, so nothing is mispronounced. What changes is pacing — v3 spends 24.6 s on the
sentence turbo says in 18.1 s, and that extra time is pauses and unhurried phrasing. If you
want the warmth back at the cost of the wait, set `ELEVENLABS_ASK_MODEL_ID=eleven_v3`.

The **take path is untouched** and still uses v3, because it is the only model that returns
the character-level timestamps the cue scheduling slices words against the music with.
`ELEVENLABS_ASK_MODEL_ID` deliberately does *not* fall back to `ELEVENLABS_MODEL_ID`, so
configuring the take voice cannot silently hand answers back to the 10-second model.

---

## 7. Turn it on in the client

The teacher URL is compiled **into** the client bundle, so this is a rebuild, not a setting.

1. In the GitHub repository, **Settings → Secrets and variables → Actions → Variables**,
   add a repository variable `TEACHER_URL` with the value from §4.
2. Push to `main` (or re-run the *Deploy to Cloudflare Pages* workflow). The
   *Configure the AI teacher for the build* step exports it as `VITE_TEACHER_URL`.
3. Load play.welte225.org. The "Spoken feedback unavailable" box should be gone and the
   Teacher Cue Mode selector should be there instead.

Only non-empty variables are exported, because Vite lets `process.env` win over
`client/.env.production` — an empty repository variable would otherwise blank out a URL
configured in that file. You can use either mechanism; the repository variable is the one that
does not require a commit.

If the box still says spoken feedback is unavailable, it is one of three things, in order of
likelihood: the CORS origin (§3), the proxy path (§4, Option B), or a `VITE_TEACHER_URL` that
never made it into the build (search the built JS for the hostname).

**To test the deployed teacher before rebuilding the client**, point one browser at it by hand
from the console on play.welte225.org — this beats the baked-in value and needs no deploy:

```js
localStorage.TEACHER_URL = 'https://teacher.welte225.org'   // delete it to go back
```

The same override is how someone runs a teacher on their own machine against the public page
(SPOKEN_FEEDBACK.md).

### Optional features

Both are off unless switched on, and both can be flipped **per browser** from the
*Prototype features* block at the top of the debug sidebar — no rebuild, no redeploy. That is
the way to try them before committing a whole deployment to them.

| Feature | Repository variable | Browser override | Effect |
|---|---|---|---|
| Agentic lesson plans | `TEACHER_AGENTIC=1` | `localStorage.TEACHER_AGENTIC` | The teacher chooses *what* to demonstrate — mode, bar range, which dimensions to exaggerate — instead of always exaggerating the whole take. Applies from the next take. |
| Ask by voice | `TEACHER_VOICE=1` | `localStorage.TEACHER_VOICE` | Adds the hold-to-ask button. Recording auto-stops after 30 s. |

Set the override to `1` or `0` to force a flag either way, or clear it to hand the flag back to
the build. Agentic mode costs about one extra render's wall-clock before playback starts
(the demo cannot be rendered until the plan names its range) — see MODERNIZATION.md, Phase 3.

---

## 8. What it costs

Per take, measured on this corpus (`estimateTokens`, chars/4):

- **System prompt: ~4.0k tokens** (realtime, compact corpus) to ~4.5k (full). This is
  byte-stable across every request of the same variant — it is built once and memoized
  precisely so the provider's prompt cache can hit it. It is the bulk of the prompt and
  the part you should expect to pay a cache rate for.
- **Per-take input: ~2.5k tokens** of scholarly detail for the bars just played, plus the
  structured diff and judgement — call it 3–3.5k.
- **Total ≈ 7–8k input tokens, a few hundred output.**

At the realtime tier's rate that is fractions of a cent per take, and the cached prefix means
the second take of a sitting costs meaningfully less than the first. Check current per-model
pricing rather than trusting a number written here — but the shape is: the LLM is cheap, and
**ElevenLabs is the line item that grows**, because it is billed per character and every take
and every answer is spoken. If a deployment ever gets expensive, that is where to look first.

The student-profile side-channel adds one small `gpt-5.4-mini` call per take. It runs after
the student has already been answered, so it costs money but not time.

---

## 9. Rolling back

Nothing here is destructive and every step is independently reversible:

- **Turn the AI off again**: delete the `TEACHER_URL` repository variable and redeploy. The
  client falls back to the exaggerated-performance-only behaviour it has today; no build
  contains a localhost URL to leak.
- **Stop the teacher**: `sudo systemctl stop vg-teacher`. The client detects the unreachable
  service on load and shows the "Spoken feedback unavailable" box.
- **Forget every lesson**: delete the contents of `SESSIONS_DIR`. Sessions are cached in
  memory too, so restart the service afterwards.
