import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type { Memory } from '../../shared/types.js';
import { buildGraph, topicLinks, type MemoryGraph } from './memory-graph.js';

export interface ObsidianRecall {
  path: string;
  title: string;
  content: string;
}

interface IndexedNote extends ObsidianRecall {
  absolutePath: string;
  modified: number;
  memory: boolean;
}

// Notes read per search: saved memories first, then the newest notes, so a
// vault that grows by dozens of turns a day never pushes out recent ones.
const MAX_NOTES = 600;
const MAX_FILES_SCANNED = 20_000;
// Friday's own labels in its conversation notes are not what they are about:
// without this, "Friday" or "owner" in a question matches every note.
const NOTE_LABELS = /^# Friday conversation · .*$|\*\*(?:Owner|Friday):\*\*/gmu;
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A file name a person can read in Obsidian: the first few words, without
 * the characters Windows or Obsidian links cannot have. */
export function noteName(text: string, words = 8) {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|#^[\]{}\u0000-\u001f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .split(' ')
      .slice(0, words)
      .join(' ')
      .slice(0, 60)
      .replace(/[.,;! ]+$/u, '') || 'Note'
  );
}

/** The value of one front-matter field ("id", "turn"), if the note has it. */
const field = (markdown: string, name: string) =>
  new RegExp(`^${name}: (.+)$`, 'mu')
    .exec(/^---\s*[\s\S]*?\n---/u.exec(markdown)?.[0] ?? '')?.[1]
    ?.trim();
const MAX_NOTE_BYTES = 64_000;
const NOTE_CACHE_MS = 10_000;
const SKIP_DIRECTORIES = new Set([
  '.obsidian',
  '.trash',
  '.git',
  'node_modules',
  'dist',
  'build',
]);
const STOP_WORDS = new Set([
  'a',
  'about',
  'after',
  'again',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'before',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'please',
  'she',
  'so',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/**
 * Friday stores conversation notes as ordinary Markdown in an Obsidian vault.
 * The owner may point this at an existing vault; the default folder is itself
 * a valid vault that can be opened directly in Obsidian.
 */
export class ObsidianMemory {
  private cache?: { expiresAt: number; root: string; notes: IndexedNote[] };

  constructor(
    private readonly configuredPath: () => string,
    /** Contact names, so notes link to the people they mention. */
    private readonly people: () => string[] = () => [],
  ) {}

  private peopleOrNone() {
    try {
      return this.people();
    } catch {
      return []; // no contacts file yet: topics alone
    }
  }

  /** "Related: [[Calls]] · [[Prince]]": Obsidian draws these as links. */
  private related(text: string, extra: string[] = []) {
    const names = [
      ...new Set([...extra, ...topicLinks(text, this.peopleOrNone())]),
    ];
    return names.length
      ? ['', `Related: ${names.map((name) => `[[${name}]]`).join(' · ')}`]
      : [];
  }

  /** Every note as Obsidian's graph view would draw it. */
  async graph(): Promise<MemoryGraph & { vault: string }> {
    return {
      vault: this.vaultPath(),
      ...buildGraph(await this.index(), this.peopleOrNone()),
    };
  }

  /** One note's text, by its path inside the vault (never outside it). */
  async readNote(path: string) {
    const root = this.vaultPath();
    const file = resolve(root, path);
    const inside = relative(root, file);
    if (
      !inside ||
      inside.startsWith('..') ||
      isAbsolute(inside) ||
      extname(file).toLocaleLowerCase() !== '.md'
    )
      return undefined;
    try {
      const markdown = await readFile(file, 'utf8');
      return {
        path: inside.replaceAll('\\', '/'),
        title: basename(file).replace(/\.md$/iu, ''),
        content: markdown.replace(/^---\s*[\s\S]*?\n---\s*/u, '').trim(),
        file,
      };
    } catch {
      return undefined;
    }
  }

  vaultPath(pathOverride?: string) {
    const configured = (pathOverride ?? this.configuredPath()).trim();
    return resolve(configured || 'data/friday-obsidian');
  }

  async prepareVault(pathOverride?: string) {
    const root = this.vaultPath(pathOverride);
    await mkdir(join(root, '.obsidian'), { recursive: true });
    await this.renameIdNotes(root);
    return root;
  }

  /** Notes from before readable names were named by their id
   * ("369bc293-….md"): renamed once, to what they say. */
  private async renameIdNotes(root: string) {
    const folders = [join(root, 'Friday', 'Memories')];
    const days = join(root, 'Friday', 'Conversations');
    try {
      for (const day of await readdir(days, { withFileTypes: true }))
        if (day.isDirectory()) folders.push(join(days, day.name));
    } catch {
      // no conversations yet
    }
    for (const folder of folders) {
      let names: string[];
      try {
        names = await readdir(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (extname(name).toLocaleLowerCase() !== '.md') continue;
        try {
          const markdown = await readFile(join(folder, name), 'utf8');
          const id = field(markdown, 'id') ?? field(markdown, 'turn');
          if (!id || name !== `${id}.md`) continue;
          const body = markdown.replace(/^---\s*[\s\S]*?\n---\s*/u, '');
          const owner = /\*\*Owner:\*\*\s*(.+)/u.exec(body)?.[1];
          const created = Date.parse(field(markdown, 'created') ?? '');
          const title = owner
            ? this.conversationName(Number.isNaN(created) ? 0 : created, owner)
            : noteName(
                body
                  .split('\n')
                  .find((line) => line.trim() && !line.startsWith('#')) ?? id,
              );
          const file = await this.freeName(folder, title, id);
          if (file !== name)
            await rename(join(folder, name), join(folder, file));
        } catch {
          // a locked note keeps its old name
        }
      }
    }
    this.cache = undefined;
  }

  /** "1150 alarm at 12": the time and the owner's first words. */
  private conversationName(createdAt: number, userText: string) {
    return `${this.localDateTime(createdAt).clock} ${noteName(userText, 6)}`;
  }

  /** `${title}.md`, or "title 2.md" when another note has that name. A note
   * with the same id (field "id" or "turn") may be replaced. */
  private async freeName(folder: string, title: string, id: string) {
    for (let n = 1; ; n++) {
      const file = `${title}${n > 1 ? ` ${n}` : ''}.md`;
      let markdown: string;
      try {
        markdown = await readFile(join(folder, file), 'utf8');
      } catch {
        return file;
      }
      if ((field(markdown, 'id') ?? field(markdown, 'turn')) === id)
        return file;
    }
  }

  /** The files holding the memory with this id, whatever they are called. */
  private async filesFor(folder: string, id: string) {
    const found: string[] = [];
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return found;
    }
    for (const name of names) {
      if (extname(name).toLocaleLowerCase() !== '.md') continue;
      try {
        const markdown = await readFile(join(folder, name), 'utf8');
        if (name === `${id}.md` || field(markdown, 'id') === id)
          found.push(name);
      } catch {
        // a locked note is left alone
      }
    }
    return found;
  }

  async saveMemory(memory: Memory, pathOverride?: string) {
    const root = this.vaultPath(pathOverride);
    const id = memory.id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) throw new Error('Invalid memory identifier.');
    const folder = join(root, 'Friday', 'Memories');
    await mkdir(folder, { recursive: true });
    const note = [
      '---',
      `id: ${id}`,
      `created: ${new Date(memory.createdAt).toISOString()}`,
      'tags:',
      '  - friday/memory',
      '---',
      '',
      '# Saved memory',
      '',
      memory.text.trim(),
      ...this.related(memory.text),
      '',
    ].join('\n');
    // Named by what it says; an older copy (an edited text, or the id-named
    // file of an older Friday) goes.
    const file = await this.freeName(folder, noteName(memory.text), id);
    await writeFile(join(folder, file), note, 'utf8');
    for (const old of await this.filesFor(folder, id))
      if (old !== file) await unlink(join(folder, old)).catch(() => {});
    this.cache = undefined;
  }

  /** Mail's latest conversation map (who is waiting on whom), as one note
   * kept up to date, plus a copy for the day. */
  async saveMailMap(task: string, report: string) {
    const root = this.vaultPath();
    const now = Date.now();
    const { date, time } = this.localDateTime(now);
    const folder = join(root, 'Friday', 'Mail');
    await mkdir(folder, { recursive: true });
    const note = [
      '---',
      `updated: ${new Date(now).toISOString()}`,
      'tags:',
      '  - friday/mail',
      '---',
      '',
      `# Gmail conversation map · ${date} ${time}`,
      '',
      `Asked: ${task.trim()}`,
      '',
      report.trim(),
      ...this.related(report, ['Email', date]),
      '',
    ].join('\n');
    await writeFile(join(folder, 'Conversation map.md'), note, 'utf8');
    await writeFile(join(folder, `${date}.md`), note, 'utf8');
    this.cache = undefined;
  }

  async deleteMemory(id: string) {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return;
    const folder = join(this.vaultPath(), 'Friday', 'Memories');
    for (const file of await this.filesFor(folder, safeId)) {
      try {
        await unlink(join(folder, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.cache = undefined;
  }

  async saveConversation(input: {
    id: string;
    createdAt: number;
    userText: string;
    assistantText: string;
  }) {
    const root = this.vaultPath();
    const { date, time } = this.localDateTime(input.createdAt);
    const id = input.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
    const safeId = id || 'turn';
    const folder = join(root, 'Friday', 'Conversations', date);
    await mkdir(folder, { recursive: true });
    const note = [
      '---',
      `date: ${date}`,
      `created: ${new Date(input.createdAt).toISOString()}`,
      `turn: ${safeId}`,
      'tags:',
      '  - friday/conversation',
      '---',
      '',
      `# Friday conversation · ${time}`,
      '',
      `**Owner:** ${input.userText.trim()}`,
      '',
      `**Friday:** ${input.assistantText.trim()}`,
      ...this.related(`${input.userText}\n${input.assistantText}`, [date]),
      '',
    ].join('\n');
    const file = await this.freeName(
      folder,
      this.conversationName(input.createdAt, input.userText),
      safeId,
    );
    await writeFile(join(folder, file), note, 'utf8');
    this.cache = undefined;
  }

  async search(query: string): Promise<ObsidianRecall[]> {
    const terms = [
      ...new Set(
        (query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
          (term) => !STOP_WORDS.has(term),
        ),
      ),
    ];
    if (!terms.length) return [];
    const notes = await this.index();
    // Whole words or their start ("call" finds "calling"), never the middle
    // of a word ("ai" must not find "said").
    const patterns = terms.map(
      (term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}`, 'u'),
    );
    return (
      notes
        .map((note) => {
          const haystack = `${note.title}\n${note.content}`
            .replace(NOTE_LABELS, ' ')
            .toLocaleLowerCase();
          const matches = terms
            .map((term, index) => ({
              term,
              found: patterns[index].test(haystack),
            }))
            .filter((match) => match.found);
          if (!matches.length) return undefined;
          const contentLower = note.content.toLocaleLowerCase();
          const firstContentMatch = matches
            .map((match) => contentLower.indexOf(match.term))
            .filter((index) => index >= 0)
            .sort((a, b) => a - b)[0];
          const start = Math.max(0, (firstContentMatch ?? 0) - 300);
          const end = Math.min(note.content.length, start + 1400);
          const excerpt = `${start ? '…' : ''}${note.content.slice(start, end).trim()}${end < note.content.length ? '…' : ''}`;
          return {
            path: note.path,
            title: note.title,
            content: excerpt,
            // A saved memory outranks a conversation with the same matches.
            score: matches.length + (note.memory ? 0.5 : 0),
            modified: note.modified,
          };
        })
        .filter((note): note is NonNullable<typeof note> => !!note)
        // Most matching words first; among equals, the newest.
        .sort((a, b) => b.score - a.score || b.modified - a.modified)
        .slice(0, 4)
        .map(({ path, title, content }) => ({ path, title, content }))
    );
  }

  private localDateTime(timestamp: number) {
    const timeZone = process.env.TIMEZONE || 'Asia/Kolkata';
    const date = new Date(timestamp);
    const partsFor = (zone: string) =>
      new Intl.DateTimeFormat('en', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = partsFor(timeZone);
    } catch {
      parts = partsFor('UTC');
    }
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '00';
    let time: string;
    try {
      time = new Intl.DateTimeFormat('en-IN', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    } catch {
      time = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    }
    // "1150": the 24-hour time, for file names that sort by time.
    const clockIn = (zone: string) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(date);
    let clock: string;
    try {
      clock = clockIn(timeZone);
    } catch {
      clock = clockIn('UTC');
    }
    return {
      date: `${value('year')}-${value('month')}-${value('day')}`,
      time,
      clock: clock.replace(':', ''),
    };
  }

  private async index() {
    const root = this.vaultPath();
    if (
      this.cache &&
      this.cache.root === root &&
      this.cache.expiresAt > Date.now()
    )
      return this.cache.notes;
    const files: { absolutePath: string; modified: number; memory: boolean }[] =
      [];
    const memories = join(root, 'Friday', 'Memories');
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8 || files.length >= MAX_FILES_SCANNED) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES_SCANNED) return;
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase()))
            await visit(absolutePath, depth + 1);
          continue;
        }
        if (
          !entry.isFile() ||
          extname(entry.name).toLocaleLowerCase() !== '.md'
        )
          continue;
        try {
          const info = await stat(absolutePath);
          if (info.size > MAX_NOTE_BYTES) continue;
          files.push({
            absolutePath,
            modified: info.mtimeMs,
            memory: directory === memories,
          });
        } catch {
          // A locked or changing note should not stop Friday from answering.
        }
      }
    };
    await visit(root, 0);
    files.sort(
      (a, b) => Number(b.memory) - Number(a.memory) || b.modified - a.modified,
    );
    const notes: IndexedNote[] = [];
    for (const file of files.slice(0, MAX_NOTES)) {
      try {
        const markdown = await readFile(file.absolutePath, 'utf8');
        notes.push({
          ...file,
          path: relative(root, file.absolutePath).replaceAll('\\', '/'),
          title: basename(file.absolutePath).replace(/\.md$/iu, ''),
          content: markdown.replace(/^---\s*[\s\S]*?\n---\s*/u, '').trim(),
        });
      } catch {
        // A locked or changing note should not stop Friday from answering.
      }
    }
    this.cache = { expiresAt: Date.now() + NOTE_CACHE_MS, root, notes };
    return notes;
  }
}
