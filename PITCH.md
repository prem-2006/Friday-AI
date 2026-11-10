# Friday: a voice assistant that does the work, in your language

**Built by Prem and Ruchi for the Gnani AI #GreatIndianAIInternshipChallenge**

## The problem

Computers still expect people to know which app to open, where a setting lives and how to type in English. For millions of Indians, that is the barrier. Most voice assistants only answer questions; they rarely finish a task across apps, the browser and the phone. Small businesses also lose customers because nobody can answer every call, in every language.

## The solution

Friday lives in a small notch above the Windows taskbar. Hold Caps Lock and speak in English, Hindi, Hinglish or another Indian language, and Friday hears which language it is, answers in it, and does the work.

- **Runs your PC:** opens apps, arranges windows, controls media, reads what is on screen.
- **Works the web:** multi-step browser tasks and background research with sources.
- **Reaches people:** WhatsApp and real phone calls, always asking before it sends.
- **Remembers you:** memories and conversations are Markdown notes in a private Obsidian vault.
- **Learns:** a task done once replays instantly, with no model call.

## For business

A dashboard lists clients by region. One click and Friday calls a client in their own language to sell, follow up or book a meeting. It answers only from a business profile the owner writes, books meetings into the calendar without double-booking, and saves every lead.

## How it works

| Layer    | Technology                                                                            |
| -------- | ------------------------------------------------------------------------------------- |
| Hearing  | Gnani Prisma, streaming, automatic language detection (`indic-auto`)                  |
| Voice    | Gnani Timbre v3.0, one voice across 10 Indian languages                               |
| Thinking | Gnani Evon or any OpenAI-compatible model (the demo uses Gemini Flash Lite)           |
| Agents   | OpenDots: Friday delegates to Navigator, Operator, Coder, Mail and Reception over MCP |
| Calls    | Exotel and Pipecat                                                                    |
| App      | Electron, React, TypeScript, Python FastAPI                                           |

## Why it is safe

Friday reads messages back and sends only after a "yes". It never enters passwords, card numbers or OTPs, and never pays. Saying "ruko" stops everything. Callers other than the owner cannot reach personal data.

## What is next

More regional languages, a mobile app, a family care mode with medicine reminders and check-in calls, and on-device models for offline use.

**Repository:** https://github.com/prem-2006/Friday-AI
