/**
 * smoke-teacher.ts — live comparison of the pre-Phase-1 prompt against the
 * grounded one, across all three tiers.
 *
 * Inputs are reconstructed from the committed `test_output/*_diff.txt` fixtures:
 * the ASCII diff table is parsed back into the `StructuredDiffEvent[]` the client
 * sends, the judgement is recomputed with the real `summarizeImmediateJudgement`,
 * and cue candidates are grouped exactly as `requestVocalStream` groups them.
 * That keeps the run offline from the Java renderer while still exercising the
 * real route handler in-process.
 *
 * TTS is skipped so the numbers are LLM latency only.
 *
 * Run: npx tsx scripts/smoke-teacher.ts [fixture...]
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openai, DEFAULT_CUE_MODELS, type CuePrepMode } from '../src/config';
import { describePlan } from '../src/plan';
import { buildTeacherSystemPrompt } from '../src/prompts/teacherStream';
import { runTeacherAsk } from '../src/routes/teacherAsk';
import { buildUserInput, runTeacherStream, type TeacherStreamRequest } from '../src/routes/teacherStream';
import { estimateTokens } from '../src/corpus';
import { __resetSessionStore, flushProfileUpdates, formatSessionHistory, readSession } from '../src/sessions';
import { summarizeImmediateJudgement } from '../client/src/judgement';
import { positionToTick } from '../client/src/shared/constants';
import type { StructuredDiffEvent } from '../client/src/mpm/types';

const OUT_DIR = 'test_output';
const RUNS_PER_CONFIG = 3;
const TIERS: CuePrepMode[] = ['realtime', 'balanced', 'studio'];

// ── Fixture parsing ──

const TYPE_BY_SECTION: Record<string, string> = {
    TEMPO: 'tempo',
    DYNAMICS: 'dynamics',
    ARTICULATION: 'articulation',
    RUBATO: 'rubato',
    'ORNAMENTS (ARPEGGIO)': 'ornament',
    'METRIC ACCENTS': 'accentuationPattern',
    'VOICE ASYNCHRONY': 'asynchrony',
};

const PRIMARY_ATTR: Record<string, string> = {
    tempo: 'bpm',
    dynamics: 'volume',
    articulation: 'relativeDuration',
    rubato: 'intensity',
    ornament: 'scale',
    accentuationPattern: 'scale',
    asynchrony: 'milliseconds.offset',
};

/** Mirrors `cueTextForDiff` in client/src/mpm/diff.ts for the types the fixtures contain. */
const cueForDiff = (type: string, delta: number): { cueText: string; direction: 'more' | 'less' } => {
    if (type === 'dynamics') return delta > 0 ? { cueText: 'leiser', direction: 'less' } : { cueText: 'lauter', direction: 'more' };
    if (type === 'tempo') return delta > 0 ? { cueText: 'ruhiger', direction: 'less' } : { cueText: 'bewegter', direction: 'more' };
    if (type === 'articulation') return delta < 0 ? { cueText: 'mehr Legato', direction: 'more' } : { cueText: 'kuerzer', direction: 'less' };
    if (type === 'rubato') return delta > 0 ? { cueText: 'ruhiger im Puls', direction: 'less' } : { cueText: 'mehr atmen', direction: 'more' };
    if (type === 'accentuationPattern') return delta > 0 ? { cueText: 'weniger betonen', direction: 'less' } : { cueText: 'mehr betonen', direction: 'more' };
    if (type === 'ornament') return delta > 0 ? { cueText: 'gleichmaessiger', direction: 'less' } : { cueText: 'oben mehr zeigen', direction: 'more' };
    return delta > 0 ? { cueText: 'weniger', direction: 'less' } : { cueText: 'mehr', direction: 'more' };
};

/** `29 bpm` → 29 · `pp(35)` → 35 · `scale: 2.3` → 2.3 */
const cellValue = (cell: string): number => {
    const parenthesised = /\(\s*(-?[\d.]+)\s*\)/.exec(cell);
    if (parenthesised) return Number(parenthesised[1]);
    const bare = /(-?[\d.]+)/.exec(cell);
    return bare ? Number(bare[1]) : 0;
};

type Fixture = {
    name: string;
    range: { from: number; to: number };
    events: StructuredDiffEvent[];
    diffText: string;
};

const parseFixture = (name: string): Fixture => {
    const diffText = readFileSync(join(OUT_DIR, `${name}_diff.txt`), 'utf8');
    const lines = diffText.split('\n');

    const header = /deviations in (m\d+\.\d+)–(m\d+\.\d+)/.exec(lines[0]);
    if (!header) throw new Error(`${name}: cannot read range from "${lines[0]}"`);
    const range = { from: positionToTick(header[1])!, to: positionToTick(header[2])! };

    const events: StructuredDiffEvent[] = [];
    let type = '';
    for (const line of lines.slice(1)) {
        const section = /^([A-Z][A-Z ()]*[A-Z)])\s*\(\d+\):/.exec(line.trim());
        if (section) {
            type = TYPE_BY_SECTION[section[1].toUpperCase()] ?? '';
            continue;
        }
        const cells = line.split('|').map((cell) => cell.trim());
        if (!type || cells.length < 4 || !/^m\d+\.\d+$/.test(cells[0])) continue;

        const [position, severity, refCell, studentCell] = cells;
        const refValue = cellValue(refCell);
        const studentValue = cellValue(studentCell);
        const delta = studentValue - refValue;
        const cue = cueForDiff(type, delta);
        events.push({
            id: `${type}_${position}_${events.length}`,
            date: positionToTick(position)!,
            position,
            type,
            severity: severity as StructuredDiffEvent['severity'],
            primaryAttr: PRIMARY_ATTR[type] ?? 'value',
            magnitude: Math.abs(delta),
            cueText: cue.cueText,
            direction: cue.direction,
            refValue,
            studentValue,
        });
    }

    if (events.length === 0) throw new Error(`${name}: no events parsed`);
    return { name, range, events, diffText };
};

/**
 * A take with almost nothing wrong with it. Every committed fixture is
 * needs_work, so without this the "reference" and "none" demos never meet a
 * situation that could call for them.
 */
const NEAR_PERFECT = '04_near_perfect';

const nearPerfectFixture = (): Fixture => {
    const base = parseFixture('01_robotic');
    const events = base.events
        .filter((event, index) => index < 2)
        .map((event, index) => ({
            ...event,
            id: `${event.type}_near_${index}`,
            severity: 'slight' as const,
            magnitude: Math.abs(event.refValue) * 0.03,
            studentValue: Number((event.refValue * 1.03).toFixed(2)),
        }));
    return {
        name: NEAR_PERFECT,
        range: base.range,
        events,
        diffText: `${events.length} deviations in m1.2–m5.4:\n(synthesised: a take that is essentially right)`,
    };
};

const loadFixture = (name: string): Fixture =>
    name === NEAR_PERFECT ? nearPerfectFixture() : parseFixture(name);

/** Same grouping `requestVocalStream` applies when no timing map exists yet. */
const buildCandidates = (events: StructuredDiffEvent[]): Array<Record<string, unknown>> => {
    const byPosition = new Map<string, StructuredDiffEvent[]>();
    for (const event of events) {
        const group = byPosition.get(event.position) ?? [];
        group.push(event);
        byPosition.set(event.position, group);
    }
    return Array.from(byPosition.entries()).map(([position, group]) => ({
        position,
        issues: group.map((event) => ({
            type: event.type,
            severity: event.severity,
            direction: event.direction,
            primaryAttr: event.primaryAttr,
            refValue: event.refValue,
            studentValue: event.studentValue,
        })),
    }));
};

const buildRequest = (fixture: Fixture, mode: CuePrepMode): TeacherStreamRequest => ({
    judgement: summarizeImmediateJudgement(fixture.events, fixture.range) as unknown as Record<string, unknown>,
    candidates: buildCandidates(fixture.events),
    diff: fixture.diffText,
    structuredDiff: fixture.events as unknown as Array<Record<string, unknown>>,
    range: fixture.range,
    mode,
    skipTts: true,
});

// ── Baseline: the prompt as it stood before Phase 1 ──

const LEGACY_SYSTEM_PROMPT = `You are a piano teacher giving a continuous, stream-of-consciousness monologue during a demonstration.
You react to how the student just played, then narrate musical cues as the demonstration unfolds.

OUTPUT FORMAT — use «MARKER» delimiters:
«JUDGE» 3-8 word reaction to the student's playing...
«m2.3» [softly] 1-4 word cue...
«m4.1» filler or cue...

DIFF GLOSSARY — terms that do NOT mean what you might assume:
- ornament: NOT trills, mordents, or turns. Means ARPEGGIATION — the temporal spread and dynamic shading of notes within a chord. NEVER use the word "ornament" in your output — talk about the arpeggio or chord voicing instead.
- rubato: a timing distortion governed by a power function (x^intensity) within a fixed-length frame. The timing self-compensates so the end of the frame is back in sync with the meter. intensity < 1 = short-long (notes at the start of the frame arrive early, notes at the end arrive late), intensity > 1 = long-short (notes at the start linger, notes at the end are compressed). intensity = 1 = no distortion.

RULES:
- Start with exactly one «JUDGE» marker: your immediate reaction (3-8 words). Honest, concise, encouraging or naming at most one problem area. No measure numbers, no digits.
- Then 1-4 cue markers at the given positions. Each cue is 1-4 words, maximum 5.
- Do NOT add any closing remark or end marker. The music speaks for itself.
- Only use positions from the given candidates. Do not invent positions.
- Each candidate has a direction field ("more" or "less") and a type. You MUST NOT reverse the direction.
- Use fragmented, associative style. Use "..." for natural pauses.
- You may optionally use Eleven-v3 audio tags per segment, e.g. [softly], [warmly], [sigh], [clears throat], [laughs], [whispers].
- Shape a small emotional arc across the sequence.
- Keep the flow natural — as if you are thinking aloud while playing. Use non-verbal fillers to sound human: "hmm...", "mhm...", "uhm...", [sigh], [clears throat]. Prefer these over verbal fillers.
- Vary your wording. If several cues address similar topics, each must sound noticeably different.
- Do not repeat the same v3 tag more than twice.
- No full explanations, no introductions, no meta-commentary.

IMPORTANT: Write everything in ${process.env.OUTPUT_LANGUAGE || 'German'}.
Respond only with the monologue text using «MARKER» delimiters.`;

/** The pre-Phase-1 input: judgement, the top-3-per-type ASCII table, candidates. */
const legacyUserInput = (fixture: Fixture): string => {
    const parts = ['=== JUDGEMENT SUMMARY ===', JSON.stringify(summarizeImmediateJudgement(fixture.events, fixture.range))];
    parts.push('\n=== DIFF ===', fixture.diffText);
    parts.push('\n=== CUE CANDIDATES ===');
    for (const candidate of buildCandidates(fixture.events)) parts.push(JSON.stringify(candidate));
    return parts.join('\n');
};

const runLegacy = async (fixture: Fixture, model = 'gpt-5-mini'): Promise<{ rawText: string; llmMs: number }> => {
    const startedAt = Date.now();
    const response = await openai.responses.create({
        model,
        instructions: LEGACY_SYSTEM_PROMPT,
        input: legacyUserInput(fixture),
    });
    return { rawText: response.output_text ?? '', llmMs: Date.now() - startedAt };
};

// ── Driver ──

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
};

type Result = {
    fixture: string;
    variant: string;
    model: string;
    latencies: number[];
    medianMs: number;
    promptTokens: number;
    samples: string[];
};

/**
 * Prompt cost with the model held constant: how much of the latency change comes
 * from the grounded prompt rather than from the new model pin.
 */
const runIsolation = async (fixtures: Fixture[]) => {
    const model = DEFAULT_CUE_MODELS.realtime;
    console.log(`\n=== PROMPT ISOLATION on ${model} (same model, old vs new prompt) ===`);
    for (const fixture of fixtures) {
        const old: number[] = [];
        const grounded: number[] = [];
        for (let run = 0; run < RUNS_PER_CONFIG; run++) {
            old.push((await runLegacy(fixture, model)).llmMs);
            grounded.push((await runTeacherStream(buildRequest(fixture, 'realtime'))).stats.llmMs);
        }
        console.log(
            `${fixture.name.padEnd(20)} old ${String(median(old)).padStart(5)}ms (${old.join('/')})   ` +
            `grounded ${String(median(grounded)).padStart(5)}ms (${grounded.join('/')})`,
        );
    }
};

// ── Phase 3: does the teacher plan a sensible demonstration? ──

/**
 * Agentic vs fixed, interleaved per run so API drift hits both equally. What the
 * plan costs in latency is one question; whether it fits the fixture's dominant
 * problem is the other, and only reading the plans answers that.
 */
const runAgentic = async (fixtures: Fixture[], tiers: CuePrepMode[]) => {
    const transcript: string[] = [];
    const say = (line: string) => { console.log(line); transcript.push(line); };
    const summary: Record<string, unknown>[] = [];

    for (const fixture of fixtures) {
        const judgement = summarizeImmediateJudgement(fixture.events, fixture.range);
        const dominant = judgement.dominantTypes.map((t) => `${t.type}(${t.count}, ${t.worstSeverity})`).join(', ');
        say(`\n=== ${fixture.name} — ${judgement.verdict} ${judgement.score}, dominant: ${dominant} ===`);

        for (const mode of tiers) {
            const fixed: number[] = [];
            const agentic: number[] = [];
            const plans: string[] = [];

            for (let run = 0; run < RUNS_PER_CONFIG; run++) {
                const before = await runTeacherStream(buildRequest(fixture, mode));
                fixed.push(before.stats.llmMs);

                const after = await runTeacherStream({ ...buildRequest(fixture, mode), agentic: true });
                agentic.push(after.stats.llmMs);
                const plan = after.plan ? describePlan(after.plan) : '(no plan returned)';
                plans.push(plan);
                say(`  [${mode} run ${run + 1}] ${after.stats.llmMs}ms  plan: ${plan}`);
                say(`      ${after.rawText.replace(/\n+/g, ' ')}`);
            }

            say(
                `  ${mode}/${DEFAULT_CUE_MODELS[mode]} median: fixed ${median(fixed)}ms (${fixed.join('/')})  `
                + `agentic ${median(agentic)}ms (${agentic.join('/')})`,
            );
            summary.push({
                fixture: fixture.name,
                mode,
                model: DEFAULT_CUE_MODELS[mode],
                verdict: judgement.verdict,
                dominantTypes: judgement.dominantTypes.map((t) => t.type),
                fixedLatencies: fixed,
                agenticLatencies: agentic,
                fixedMedianMs: median(fixed),
                agenticMedianMs: median(agentic),
                plans,
            });
        }
    }

    say('\n=== SUMMARY (LLM latency, TTS excluded) ===');
    say('fixture              tier       fixed    agentic  delta');
    for (const row of summary) {
        const fixedMs = row.fixedMedianMs as number;
        const agenticMs = row.agenticMedianMs as number;
        say(
            `${String(row.fixture).padEnd(20)} ${String(row.mode).padEnd(10)} `
            + `${String(fixedMs).padStart(6)}   ${String(agenticMs).padStart(6)}   `
            + `${agenticMs - fixedMs >= 0 ? '+' : ''}${agenticMs - fixedMs}ms`,
        );
    }

    writeFileSync(join(OUT_DIR, 'phase3_agentic.txt'), transcript.join('\n'));
    writeFileSync(join(OUT_DIR, 'phase3_summary.json'), JSON.stringify(summary, null, 2));
    console.log(`\nWrote ${OUT_DIR}/phase3_agentic.txt and phase3_summary.json`);
};

// ── Phase 2: does the teacher remember the previous take? ──

const SESSION_DIR = join(OUT_DIR, 'phase2_sessions');
const SESSION_ID = 'smoke5555-2222-4444-8888-aaaaaaaaaaaa';

/**
 * The same student plays twice. Take 1 seeds the session; take 2 is then run
 * both stateless and with the session attached, so the latency cost of carrying
 * the history — and whether the «JUDGE» actually uses it — are both visible.
 */
const runTwoTake = async (first: Fixture, second: Fixture, mode: CuePrepMode) => {
    process.env.SESSIONS_DIR = SESSION_DIR;
    rmSync(SESSION_DIR, { recursive: true, force: true });
    mkdirSync(SESSION_DIR, { recursive: true });
    __resetSessionStore();

    const transcript: string[] = [];
    const say = (line: string) => { console.log(line); transcript.push(line); };

    say(`=== TWO-TAKE SESSION (${mode}/${DEFAULT_CUE_MODELS[mode]}) ===`);
    say(`take 1 = ${first.name}, take 2 = ${second.name}\n`);

    // Baseline: take 2 with no session at all — today's behavior.
    const statelessLatencies: number[] = [];
    for (let run = 0; run < RUNS_PER_CONFIG; run++) {
        const response = await runTeacherStream(buildRequest(second, mode));
        statelessLatencies.push(response.stats.llmMs);
        say(`[stateless run ${run + 1}] ${response.stats.llmMs}ms\n${response.rawText}\n`);
    }

    // Take 1: seeds the session, then the profile side-channel catches up.
    const takeOne = await runTeacherStream({ ...buildRequest(first, mode), sessionId: SESSION_ID });
    say(`[take 1 · session] ${takeOne.stats.llmMs}ms\n${takeOne.rawText}\n`);
    await flushProfileUpdates();
    say(`profile after take 1: ${JSON.stringify(readSession(SESSION_ID)?.profile ?? null)}\n`);

    // Take 2, repeatedly: the history grows by one take each run.
    const sessionLatencies: number[] = [];
    for (let run = 0; run < RUNS_PER_CONFIG; run++) {
        const history = formatSessionHistory(readSession(SESSION_ID));
        const response = await runTeacherStream({ ...buildRequest(second, mode), sessionId: SESSION_ID });
        sessionLatencies.push(response.stats.llmMs);
        say(`[take ${run + 2} · session, history ${estimateTokens(history)} tok] ${response.stats.llmMs}ms\n${response.rawText}\n`);
        await flushProfileUpdates();
    }

    const finalHistory = formatSessionHistory(readSession(SESSION_ID));
    say('=== HISTORY AS THE MODEL LAST SAW IT ===');
    say(finalHistory);
    say('');
    say('=== LATENCY (LLM only) ===');
    say(`stateless median ${median(statelessLatencies)}ms (${statelessLatencies.join('/')})`);
    say(`with history median ${median(sessionLatencies)}ms (${sessionLatencies.join('/')})`);
    say(`history cost ${estimateTokens(finalHistory)} prompt tokens`);

    writeFileSync(join(OUT_DIR, 'phase2_two_take.txt'), transcript.join('\n'));
    writeFileSync(join(OUT_DIR, 'phase2_summary.json'), JSON.stringify({
        mode,
        model: DEFAULT_CUE_MODELS[mode],
        fixtures: [first.name, second.name],
        statelessLatencies,
        sessionLatencies,
        statelessMedianMs: median(statelessLatencies),
        sessionMedianMs: median(sessionLatencies),
        historyTokens: estimateTokens(finalHistory),
        profile: readSession(SESSION_ID)?.profile ?? null,
    }, null, 2));
    console.log(`\nWrote ${OUT_DIR}/phase2_two_take.txt and phase2_summary.json`);
};

// ── Phase 4: can the student ask, and does the answer stay grounded? ──

const ASK_SESSION_DIR = join(OUT_DIR, 'phase4_sessions');
const ASK_SESSION_ID = 'smoke4444-1111-4444-8888-bbbbbbbbbbbb';
const TEXT_QUESTION = 'Warum wird es zum Ende hin langsamer?';
const SPOKEN_QUESTION = 'Warum wird es in Takt vier langsamer?';
const FOLLOW_UP = 'Und was mache ich dann konkret mit der linken Hand?';

/** The question as speech, so the microphone path can be exercised without a microphone. */
const speakQuestion = async (text: string): Promise<{ data: string; mimeType: string; model: string; ms: number }> => {
    const models = [process.env.OPENAI_SMOKE_TTS_MODEL, 'gpt-4o-mini-tts', 'tts-1'].filter(Boolean) as string[];
    let lastError: unknown;

    for (const model of models) {
        const startedAt = Date.now();
        try {
            const response = await openai.audio.speech.create({
                model,
                voice: 'alloy',
                input: text,
                response_format: 'mp3',
            });
            const data = Buffer.from(await response.arrayBuffer()).toString('base64');
            return { data, mimeType: 'audio/mpeg', model, ms: Date.now() - startedAt };
        } catch (err) {
            lastError = err;
            console.log(`  (tts model ${model} unavailable, trying the next one)`);
        }
    }
    throw lastError;
};

/** Transcription writes "Takt 4" where the speaker said "Takt vier"; both are correct. */
const NUMBER_WORDS = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];

/** Same words, ignoring case, punctuation, spacing and how numbers are written. */
const normalizeSpoken = (text: string): string => {
    const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim().split(' ');
    return words.map((word) => {
        const asWord = NUMBER_WORDS.indexOf(word);
        return asWord === -1 ? word : String(asWord);
    }).join(' ');
};

/**
 * The same question with no corpus in the prompt. Phase 1 measured grounding by
 * comparing against the prompt that came before it; a question deserves the same
 * control, or "the answer sounds knowledgeable" is just a vibe.
 */
const UNGROUNDED_ASK_PROMPT = `You are a piano teacher. A student who is playing Schumann's "Träumerei" stops and asks you a question.
Answer in about 60 spoken words of plain German prose. No lists, no headings, no markers.`;

const runUngroundedAnswer = async (question: string, mode: CuePrepMode): Promise<string> => {
    const response = await openai.responses.create({
        model: DEFAULT_CUE_MODELS[mode],
        instructions: UNGROUNDED_ASK_PROMPT,
        input: `=== STUDENT QUESTION ===\n${question}`,
    });
    return (response.output_text ?? '').trim();
};

const runAsk = async (fixture: Fixture, mode: CuePrepMode) => {
    process.env.SESSIONS_DIR = ASK_SESSION_DIR;
    rmSync(ASK_SESSION_DIR, { recursive: true, force: true });
    mkdirSync(ASK_SESSION_DIR, { recursive: true });
    __resetSessionStore();

    const transcript: string[] = [];
    const say = (line: string) => { console.log(line); transcript.push(line); };

    say(`=== ASK (${mode}/${DEFAULT_CUE_MODELS[mode]}) — session seeded with ${fixture.name} ===\n`);

    // The teacher has to have heard something before it can be asked about it.
    const take = await runTeacherStream({ ...buildRequest(fixture, mode), sessionId: ASK_SESSION_ID });
    say(`[take 1] ${take.stats.llmMs}ms\n${take.rawText}\n`);
    await flushProfileUpdates();

    // (a) The typed path — the same route, without paying for transcription.
    const typed = await runTeacherAsk({ question: TEXT_QUESTION, sessionId: ASK_SESSION_ID, mode, skipTts: true });
    say(`[text question] "${TEXT_QUESTION}"`);
    say(`[answer] ${typed.stats.llmMs}ms, ${typed.answerText.split(/\s+/).length} words`);
    say(typed.answerText);
    say('');

    const ungrounded = await runUngroundedAnswer(TEXT_QUESTION, mode);
    say('[control — same question, same model, no corpus and no session]');
    say(ungrounded);
    say('');

    // (b) The microphone path, loopbacked: question spoken by TTS, heard back by the route.
    say('[audio loopback]');
    const spoken = await speakQuestion(SPOKEN_QUESTION);
    say(`spoken by ${spoken.model} in ${spoken.ms}ms, ${Math.round(spoken.data.length * 0.75 / 1024)} KB of mp3`);
    const heard = await runTeacherAsk({
        audio: { data: spoken.data, mimeType: spoken.mimeType },
        sessionId: ASK_SESSION_ID,
        mode,
        skipTts: true,
    });
    const faithful = normalizeSpoken(heard.transcript) === normalizeSpoken(SPOKEN_QUESTION);
    say(`said:  "${SPOKEN_QUESTION}"`);
    say(`heard: "${heard.transcript}"  (${faithful ? 'verbatim' : 'DIFFERS'}, ${heard.stats.transcribeMs}ms)`);
    say(`[answer] ${heard.stats.llmMs}ms, ${heard.answerText.split(/\s+/).length} words`);
    say(heard.answerText);
    say('');

    // A third question: by now the teacher has a take and two answers behind it.
    const followUp = await runTeacherAsk({ question: FOLLOW_UP, sessionId: ASK_SESSION_ID, mode, skipTts: true });
    say(`[follow-up] "${FOLLOW_UP}"`);
    say(`[answer] ${followUp.stats.llmMs}ms, ${followUp.answerText.split(/\s+/).length} words`);
    say(followUp.answerText);
    say('');

    // The spoken answer itself, once, so the whole chain is proven end to end.
    let ttsMs = 0;
    let audioBytes = 0;
    if (process.env.ELEVENLABS_API_KEY) {
        const voiced = await runTeacherAsk({ question: TEXT_QUESTION, sessionId: ASK_SESSION_ID, mode });
        ttsMs = voiced.stats.ttsMs;
        audioBytes = Math.round(voiced.audioBase64.length * 0.75);
        say(`[elevenlabs] ${ttsMs}ms, ${Math.round(audioBytes / 1024)} KB of mp3 for ${voiced.answerText.length} characters`);
        say('');
    } else {
        say('[elevenlabs] no key — spoken answer skipped\n');
    }

    say('=== WHAT THE NEXT TAKE WILL SEE ===');
    say(formatSessionHistory(readSession(ASK_SESSION_ID)));

    writeFileSync(join(OUT_DIR, `phase4_ask_${mode}.txt`), transcript.join('\n'));
    writeFileSync(join(OUT_DIR, `phase4_summary_${mode}.json`), JSON.stringify({
        mode,
        model: DEFAULT_CUE_MODELS[mode],
        fixture: fixture.name,
        text: { question: TEXT_QUESTION, answer: typed.answerText, llmMs: typed.stats.llmMs, ungrounded },
        loopback: {
            question: SPOKEN_QUESTION,
            ttsModel: spoken.model,
            transcript: heard.transcript,
            faithful,
            transcribeMs: heard.stats.transcribeMs,
            answer: heard.answerText,
            llmMs: heard.stats.llmMs,
            totalMs: heard.stats.totalMs,
        },
        followUp: { question: FOLLOW_UP, answer: followUp.answerText, llmMs: followUp.stats.llmMs },
        elevenlabs: { ttsMs, audioBytes },
    }, null, 2));
    console.log(`\nWrote ${OUT_DIR}/phase4_ask_${mode}.txt and phase4_summary_${mode}.json`);
};

const main = async () => {
    if (!process.env.OPENAI_API_KEY) {
        console.log('OPENAI_API_KEY missing — skipping live smoke test.');
        return;
    }
    mkdirSync(OUT_DIR, { recursive: true });

    const args = process.argv.slice(2);
    const isolateOnly = args.includes('--isolate');
    const twoTake = args.includes('--two-take');
    const agentic = args.includes('--agentic');
    const ask = args.includes('--ask');
    const names = args.filter((arg) => !arg.startsWith('--'));

    if (ask) {
        const modeArg = args.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
        await runAsk(loadFixture(names[0] ?? '02_rushing_loud'), (modeArg as CuePrepMode) ?? 'balanced');
        return;
    }

    if (agentic) {
        const modeArg = args.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
        await runAgentic(
            (names.length > 0 ? names : ['01_robotic', '02_rushing_loud', '03_timid', NEAR_PERFECT]).map(loadFixture),
            modeArg ? [modeArg as CuePrepMode] : ['realtime', 'studio'],
        );
        return;
    }

    if (isolateOnly) {
        await runIsolation((names.length > 0 ? names : ['01_robotic', '02_rushing_loud', '03_timid']).map(parseFixture));
        return;
    }

    if (twoTake) {
        const [first, second] = (names.length === 2 ? names : ['01_robotic', '02_rushing_loud']).map(parseFixture);
        const modeArg = args.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
        await runTwoTake(first, second, (modeArg as CuePrepMode) ?? 'realtime');
        return;
    }

    const fixtures = (names.length > 0 ? names : ['01_robotic', '02_rushing_loud', '03_timid']).map(parseFixture);
    const results: Result[] = [];

    for (const fixture of fixtures) {
        console.log(`\n=== ${fixture.name} (${fixture.events.length} events, ticks ${fixture.range.from}–${fixture.range.to}) ===`);

        // Baseline: old prompt, old model pin for the balanced tier.
        const legacyModel = 'gpt-5-mini';
        const legacy: Result = {
            fixture: fixture.name, variant: 'legacy', model: legacyModel,
            latencies: [], medianMs: 0,
            promptTokens: estimateTokens(LEGACY_SYSTEM_PROMPT) + estimateTokens(legacyUserInput(fixture)),
            samples: [],
        };
        for (let run = 0; run < RUNS_PER_CONFIG; run++) {
            const { rawText, llmMs } = await runLegacy(fixture, legacyModel);
            legacy.latencies.push(llmMs);
            legacy.samples.push(rawText);
            console.log(`  legacy/${legacyModel} run ${run + 1}: ${llmMs}ms`);
        }
        legacy.medianMs = median(legacy.latencies);
        results.push(legacy);
        writeFileSync(join(OUT_DIR, `modernized_${fixture.name}_legacy.txt`), legacy.samples.join('\n---\n'));

        for (const mode of TIERS) {
            const request = buildRequest(fixture, mode);
            const result: Result = {
                fixture: fixture.name, variant: mode, model: DEFAULT_CUE_MODELS[mode],
                latencies: [], medianMs: 0,
                promptTokens: estimateTokens(buildTeacherSystemPrompt({ compactCorpus: mode === 'realtime' }))
                    + estimateTokens(buildUserInput(request, true)),
                samples: [],
            };
            for (let run = 0; run < RUNS_PER_CONFIG; run++) {
                const response = await runTeacherStream(request);
                result.latencies.push(response.stats.llmMs);
                result.samples.push(response.rawText);
                console.log(`  ${mode}/${result.model} run ${run + 1}: ${response.stats.llmMs}ms`);
            }
            result.medianMs = median(result.latencies);
            results.push(result);
            writeFileSync(join(OUT_DIR, `modernized_${fixture.name}_${mode}.txt`), result.samples.join('\n---\n'));
        }
    }

    console.log('\n=== SUMMARY (LLM latency, TTS excluded) ===');
    console.log('fixture              variant    model             median   runs               prompt_tok');
    for (const r of results) {
        console.log(
            `${r.fixture.padEnd(20)} ${r.variant.padEnd(10)} ${r.model.padEnd(17)} ${String(r.medianMs).padStart(6)}   ` +
            `${r.latencies.join('/').padEnd(18)} ${String(r.promptTokens).padStart(10)}`,
        );
    }

    writeFileSync(join(OUT_DIR, 'modernized_summary.json'), JSON.stringify(results, null, 2));
    console.log(`\nWrote ${OUT_DIR}/modernized_*.txt and modernized_summary.json`);
};

await main();
