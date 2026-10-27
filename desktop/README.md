# Career Ops desktop

A Mac app over career-ops auto-apply: every application with its status, answers, resume and
screenshots; status emails read from your inbox (rejections, interviews); outreach and cold outreach;
and Settings for everything personal.

## Set up (new user)

You need: macOS, Node 22+, Python 3, the [Claude Code](https://claude.com/claude-code) CLI (logged in),
and a Gmail account with an [app password](https://myaccount.google.com/apppasswords).

```bash
git clone https://github.com/OmarAshour02/career-ops.git ~/career-ops
cd ~/career-ops && npm install
cd desktop && npm install && npm run install-app     # puts "Career Ops" in ~/Applications
```

Open **Career Ops**. The first-run setup asks for your details, email account, resume PDF and what the
system may do alone. Nothing is submitted or sent until you tick those permissions.
The setup also checks Claude Code (required) and opencode (optional: without it the job fit check
uses Claude Haiku instead of free DeepSeek), and reads your resume PDF into `cv.md` for you to check.
Writers take facts and numbers only from `cv.md`; live runs stay off while it is empty.
Pick the model for each job in Settings → Run controls → AI models (saved under `models:` in
`config/apply-facts.yml`).

**Let an AI fill everything:** open Claude Code in the career-ops folder and say
*"set me up, follow AI-SETUP.md"*. It interviews you and fills every file below, including
answers to common form questions, so your first runs don't get stuck.

## Where things live

| What | File |
|---|---|
| Contact, answers, salary, limits, outreach text, permissions, schedule | `config/apply-facts.yml` (template: `config/apply-facts.example.yml`) |
| Gmail login, Hunter key | `.env` |
| Resume facts | `cv.md` |
| Resume PDF | `output/master/…` (Settings → Resume) |
| Daily run | `~/Library/LaunchAgents/com.careerops.daily.plist` (Settings → Run controls) |

The `.app` is only a launcher: it loads `desktop/` from your career-ops folder, so code changes show up
on the next start. Rebuild (`npm run install-app`) only after changing `main.mjs` or `preload.cjs`.

Dev check: `CO_SNAPSHOT=/tmp/shots CO_SNAPSHOT_STEPS=overview,apps:resume,settings:run npx electron .`
saves a PNG of each view and quits.
