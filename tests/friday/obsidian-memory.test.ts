import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ObsidianMemory } from '../../src/friday/server/obsidian-memory';

let vault: string;
let memory: ObsidianMemory;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'friday-vault-'));
  memory = new ObsidianMemory(() => vault);
});
afterEach(() => rm(vault, { recursive: true, force: true }));

const turn = (
  id: string,
  userText: string,
  assistantText: string,
  at: number,
) => memory.saveConversation({ id, createdAt: at, userText, assistantText });

async function age(path: string, minutesAgo: number) {
  const when = new Date(Date.now() - minutesAgo * 60_000);
  await utimes(join(vault, path), when, when);
}

test("Friday's own labels in a note do not count as a match", async () => {
  await turn('t1', 'open notepad', 'Notepad is open.', Date.now());
  // Every conversation note says "Owner:" and "Friday:".
  expect(await memory.search('Friday owner')).toEqual([]);
  expect(await memory.search('notepad')).toHaveLength(1);
});

test('a word matches whole words or their start, never the middle', async () => {
  await turn('t1', 'what did he say', 'He said hello.', Date.now());
  await turn('t2', 'tell me about AI agents', 'Here is a summary.', Date.now());
  const found = await memory.search('ai');
  expect(found.map((note) => note.title)).toEqual([
    expect.stringMatching(/^\d{4} tell me about AI agents$/u),
  ]);
  expect(await memory.search('call')).toEqual([]);
  await turn('t3', 'calling Didi now', 'Okay.', Date.now());
  expect((await memory.search('call')).map((note) => note.title)).toEqual([
    expect.stringMatching(/^\d{4} calling Didi now$/u),
  ]);
});

test('among equal matches the newest note comes first', async () => {
  const day = '2026-10-25';
  await turn(
    'old',
    'set a timer for tea',
    'Done.',
    Date.parse(`${day}T05:00:00Z`),
  );
  await turn(
    'new',
    'set a timer for rice',
    'Done.',
    Date.parse(`${day}T06:00:00Z`),
  );
  // Named by the time (India) and the owner's words.
  await age(`Friday/Conversations/${day}/1030 set a timer for tea.md`, 60);
  await age(`Friday/Conversations/${day}/1130 set a timer for rice.md`, 1);
  const found = await memory.search('timer');
  expect(found.map((note) => note.title)).toEqual([
    '1130 set a timer for rice',
    '1030 set a timer for tea',
  ]);
});

test('a saved memory outranks a conversation with the same words', async () => {
  await turn('t1', 'my sister lives in Pune', 'Okay.', Date.now());
  await memory.saveMemory({
    id: 'm1',
    text: 'Didi lives in Pune.',
    createdAt: Date.now() - 86_400_000,
  });
  await age('Friday/Memories/Didi lives in Pune.md', 24 * 60);
  const found = await memory.search('pune');
  expect(found[0].path).toBe('Friday/Memories/Didi lives in Pune.md');
});

test('memories are named by what they say, and an edit or delete finds them', async () => {
  const folder = join(vault, 'Friday', 'Memories');
  await memory.saveMemory({ id: 'm1', text: 'Papa likes chai.', createdAt: 1 });
  await memory.saveMemory({ id: 'm2', text: 'Papa likes chai.', createdAt: 2 });
  expect((await readdir(folder)).sort()).toEqual([
    'Papa likes chai 2.md',
    'Papa likes chai.md',
  ]);
  await memory.saveMemory({
    id: 'm1',
    text: 'Papa: chai, no sugar',
    createdAt: 1,
  });
  await memory.deleteMemory('m2');
  expect(await readdir(folder)).toEqual(['Papa chai, no sugar.md']);
});

test('notes an older Friday named by their id get readable names once', async () => {
  const day = join(vault, 'Friday', 'Conversations', '2026-10-24');
  const memories = join(vault, 'Friday', 'Memories');
  await mkdir(day, { recursive: true });
  await mkdir(memories, { recursive: true });
  await writeFile(
    join(day, 'a1b2.md'),
    '---\ndate: 2026-10-24\ncreated: 2026-10-24T06:20:00.000Z\nturn: a1b2\n---\n\n# Friday conversation · 11:50 am\n\n**Owner:** alarm at 12 please\n\n**Friday:** Done.\n',
  );
  await writeFile(
    join(memories, 'c3d4.md'),
    '---\nid: c3d4\n---\n\n# Saved memory\n\nDidi lives in Pune.\n',
  );
  await writeFile(join(memories, 'My own note.md'), '# Mine\n');
  await memory.prepareVault();
  await memory.prepareVault();
  expect(await readdir(day)).toEqual(['1150 alarm at 12 please.md']);
  expect((await readdir(memories)).sort()).toEqual([
    'Didi lives in Pune.md',
    'My own note.md',
  ]);
});

test("the owner's own notes in the vault are searched too", async () => {
  await mkdir(join(vault, 'Projects'), { recursive: true });
  await writeFile(
    join(vault, 'Projects', 'Hackathon.md'),
    '# Hackathon\n\nDemo day is on Friday at 4 PM.',
  );
  const found = await memory.search('demo');
  expect(found.map((note) => note.path)).toEqual(['Projects/Hackathon.md']);
});
