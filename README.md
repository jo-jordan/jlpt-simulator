# JLPT N2 Simulator

A React + TypeScript + Vite study product for turning your own JLPT N2 notes into realistic timed practice.

## Current product flow

- Home screen focuses on starting a mock session and launching AI generation.
- Settings holds library management, document import, manual entry creation, OpenAI API key setup, and model selection.
- Live sessions run in a dedicated full-screen exam mode instead of a card layout.
- AI-generated quiz sets are stored inside the same local library JSON model and can be reused later.

## Features

- Import local `json`, `md`, `txt`, and `docx` study docs.
- Generate AI quiz sets from your existing grammar and vocabulary entries.
- Generate richer AI quiz sets with `single_select`, `cloze_select`, and `order_select` questions.
- Save AI-generated quiz sets back into a connected local JSON file when supported by the browser.
- Persist the library and quiz history in browser storage even without a connected file.

## Run locally

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## JSON library shape

```json
{
  "title": "My JLPT Notes",
  "level": "N2",
  "entries": [
    {
      "id": "vocabulary-001",
      "level": "N2",
      "section": "language_knowledge",
      "subsection": "vocabulary",
      "item_type": "文脈規定",
      "source_type": "original",
      "instructions_ja": "語彙として最も適切なものを選んでください。",
      "instructions_zh": "请选择最合适的词汇项目。",
      "passage": {
        "text": "周囲への配慮を忘れないようにしよう。",
        "segments": ["周囲への配慮を忘れないようにしよう。"],
        "metadata": {}
      },
      "question": {
        "stem": "配慮",
        "blank_positions": [],
        "choices": [],
        "correct_choice_id": null,
        "correct_answers": [],
        "answer_format": "single_choice"
      },
      "audio": {
        "audio_id": null,
        "transcript": null,
        "speaker_notes": [],
        "play_limit": 1
      },
      "explanation": {
        "ja": null,
        "zh": null,
        "grammar_points": [],
        "vocab_points": ["配慮"]
      },
      "tags": [],
      "difficulty": "medium",
      "estimated_time_sec": 45,
      "type": "vocabulary",
      "term": "配慮",
      "reading": "はいりょ",
      "meaning": "consideration",
      "example": "周囲への配慮を忘れないようにしよう。"
    }
  ],
  "quizSets": []
}
```

Markdown and text imports support pipe-separated rows:

```text
grammar | 〜にすぎない |  | no more than; merely | それはうわさにすぎない。 | Used to downplay something.
vocabulary | 柔軟 | じゅうなん | flexible | 柔軟な考え方が必要だ。 | Useful in abstract contexts.
```

Reference files:

- [docs/sample-library.json](/Users/jojordan/projs/JLPT-Simulator/docs/sample-library.json)
- [docs/sample-library.md](/Users/jojordan/projs/JLPT-Simulator/docs/sample-library.md)

## N2 taxonomy used in local docs

- `language_knowledge / vocabulary`: `漢字読み`, `表記`, `語形成`, `文脈規定`, `言い換え類義`, `用法`
- `language_knowledge / grammar`: `文の文法1`, `文の文法2`, `文章の文法`
- `reading / reading`: `短文`, `中文章`, `統合理解`, `主張理解`, `情報検索`
- `listening / listening`: `課題理解`, `ポイント理解`, `概要理解`, `即時応答`, `統合理解`

Right now the simulator actively uses the `language_knowledge` items first, but the local schema already supports reading and listening content so the project can expand into those sections without another data migration.

## OpenAI notes

The project now supports a Cloudflare full-stack path where OpenAI keys are stored on the backend instead of in the browser.

## Cloudflare full-stack setup

This repo now includes:

- A Cloudflare Worker API in [worker/index.ts](/Users/jojordan/projs/JLPT-Simulator/worker/index.ts)
- A D1 schema in [migrations/0001_initial.sql](/Users/jojordan/projs/JLPT-Simulator/migrations/0001_initial.sql)
- Wrangler config in [wrangler.toml](/Users/jojordan/projs/JLPT-Simulator/wrangler.toml)

### What the backend stores per user

- Login credentials
- Encrypted OpenAI API key
- Selected model and language preference
- The user’s JLPT library JSON and generated quiz sets

### Required setup

1. Create the D1 database and replace the placeholder `database_id` in [wrangler.toml](/Users/jojordan/projs/JLPT-Simulator/wrangler.toml).
2. Set the Worker secret:

```bash
wrangler secret put APP_SECRET
```

3. Apply migrations:

```bash
npm run db:migrate:local
# or
npm run db:migrate:remote
```

### Local dev

```bash
npm run dev
```

### Deploy to Cloudflare

```bash
npm run cf:deploy
```

### Architecture note

- The React app is built as the client bundle.
- The Worker serves the API and static assets.
- AI quiz generation is executed server-side by the Worker using the stored encrypted OpenAI key.
