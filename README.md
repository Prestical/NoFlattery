# NoFlattery

A small local web app that tells you whether an idea should be **KILLed, FIXed or SHIPped** before you spend time on it.
You describe the idea in plain text; the app scores it, explains the verdict, and gives you a one-page report you can export.

```
Idea  →  Jev scores a rubric  →  rules decide the verdict  →  local LLM (Ollama) explains it  →  report
```

| Step | Who does it | What it produces |
|------|-------------|------------------|
| 1. Scoring | **Jev** (API) | A 0–4 score and a confidence for each rubric question |
| 2. Decision | **Plain code** (no AI) | Verdict, strengths, weaknesses, low-confidence answers, path to SHIP |
| 3. Explanation | **Ollama** (runs on your machine) | The reason, top 3 risks, advice, and a test to run this week |

Strengths, weaknesses and the path to SHIP are computed from Jev's scores by code, so the small local model cannot invent or misquote them. It only writes the prose.

The server listens on `127.0.0.1` only. It is meant to run on your own computer and is not reachable from the network.

> **Privacy:** the idea text is sent to the Jev API for scoring. Ollama runs fully locally. Don't paste anything confidential you aren't allowed to send to Jev.

---

## Requirements

- **Node.js 18 or newer** (uses the built-in `fetch`; there are no npm dependencies, so no `npm install`)
- **[Ollama](https://ollama.com)** installed and running, with a model pulled (e.g. `gemma3:4b`)
- A **Jev API key** and endpoint from your TypeSafe account

## Setup

1. **Get the code** and open a terminal in the project folder.

2. **Install a local model** with Ollama (once):
   ```bash
   ollama pull gemma3:4b
   ```
   `gemma3:4b` is fast and good enough because it only writes the explanation. A bigger model gives sharper wording. Any model you pull shows up in the app's model dropdown.

3. **Create your `.env`** from the template:
   ```bash
   cp .env.example .env
   ```
   Then fill in every value:

   | Variable | Meaning |
   |----------|---------|
   | `JEV_KEY` | Your Jev API key (secret) |
   | `JEV_URL` | The Jev endpoint URL from your account |
   | `JEV_MODEL` | The Jev model name to use |
   | `OLLAMA_URL` | Where Ollama is listening, normally `http://127.0.0.1:11434` |
   | `OLLAMA_MODEL` | Default model for explanations, e.g. `gemma3:4b` |
   | `PORT` | Port for this web app, e.g. `8070` |

   All six are required. The server refuses to start and tells you which one is missing. `.env` is git-ignored, so your key never gets committed.

   Optional: `JEV_PRICE_PER_M_INPUT` and `JEV_PRICE_PER_M_OUTPUT` (USD per million tokens) change how the Jev cost is estimated.

## Run

Make sure Ollama is running (the desktop app, or `ollama serve`), then:

```bash
node server.js        # or: npm start
```

Open `http://localhost:<PORT>` in your browser. Stop it with `Ctrl+C`.

Run the unit tests for the scoring rules with:

```bash
npm test
```

## Using the app

1. **Pick the project type** (top-left select). It decides which questions count (see below).
2. **Pick the model** if you have more than one in Ollama.
3. **Write the idea** in the text box. The more of these you answer, the better the score:
   what problem, for whom, why now · how you measure success · what you will and won't deliver ·
   who must agree · resources, skills and time · the top risks · what you give up by doing it.
4. Click **Categorize**. It takes a few seconds to a minute, depending on your model.
5. The input moves to the top and the report appears underneath.

### Reading the report

- **Verdict + score (0–100)** and whether the verdict is *firm*. If low-confidence answers could flip it, the report says what it could become.
- **Scores:** one tile per question with the 0–4 score, Jev's confidence (⚠ when low), and the rubric level it matched.
- **Strengths / Weaknesses:** the highest and lowest scores.
- **Unsure answers:** answers where Jev's confidence was below 50%.
- **Top 3 risks:** each with a mitigation and an early warning signal.
- **Path to SHIP** (or **Next improvements** for a SHIP verdict): the changes that gain the most points, shown as "now → next level" from the rubric. Gate questions that block SHIP come first.
- **Advice** and **Test this week.**

### How the verdict is decided

Each question has a weight; the weighted average becomes the 0–100 score.

- **KILL:** score below 40, or the *Problem* score is under 0.5
- **SHIP:** score 70 or higher **and** every gate question scores at least 2.0
- **FIX:** everything in between

*Gate questions* can veto SHIP no matter how high the total is: Problem always, and Demand for startups.

### Project types

| Type | Questions | Notes |
|------|-----------|-------|
| **Startup / product** | All 12 | Demand is a gate; Money and Reach count |
| **Team / internal tool** | 11 (no Reach) | Money and Difference weigh less |
| **Personal project** | 10 (no Money, no Reach) | Demand is no longer a gate; the LLM is told not to suggest market work |

Dropped questions are not sent to Jev at all.

### History and re-scoring

Every run is saved as JSON in `Reports/history/`. The **History** button lists saved reports; sort by newest or best score, reopen one, or delete it.
If you edit a saved idea and run it again, the report shows the score change per question and in total.

### Exporting

- **Print / PDF:** opens the browser's print dialog. The report is measured and scaled automatically to fit **one A4 page** (shrinks long reports, enlarges short ones). In the dialog choose *Save as PDF*; leave margins on *Default* and scale at *100%*.
- **Markdown:** downloads a `.md` file.
- **HTML:** downloads a standalone `.html` file with the styling included.

## Project layout

```
server.js            Node server: Jev scoring, verdict rules, Ollama call, history API
public/index.html    Page structure
public/style.css     Screen layout and the one-page print layout
public/app.js        UI, report rendering, history, exports, print fitting
tests/logic.test.js  Unit tests for verdicts, profiles, facts and model-output cleanup
Reports/history/     Saved reports (git-ignored)
usage.json           Running Jev token/cost totals (git-ignored)
.env / .env.example  Your settings / the empty template
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing in .env: …` on start | Add the listed variables to `.env` (copy them from `.env.example`) |
| `Cannot reach Ollama at …` | Start Ollama and check `OLLAMA_URL` |
| Model dropdown is empty or wrong | Run `ollama list`; pull a model with `ollama pull <name>` |
| `EADDRINUSE` | The port is taken; change `PORT` in `.env` |
| Report shows the verdict but "Explanation unavailable" | The LLM failed; click Categorize again, or try a different model |
| Jev errors (HTTP 401/403) | Check `JEV_KEY`, `JEV_URL` and `JEV_MODEL` |
| PDF spills onto a second page | Set the print scale to 100% and paper to A4 portrait; margins on Default |
