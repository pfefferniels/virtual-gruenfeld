export type MidiMessageEvent = { tMs: number; data: Uint8Array };

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n | 0));
const u16be = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) =>
    new Uint8Array([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

const vlq = (value: number) => {
    let v = Math.max(0, value >>> 0);
    const bytes: number[] = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
        bytes.unshift((v & 0x7f) | 0x80);
        v >>= 7;
    }
    return new Uint8Array(bytes);
};

const concatBytes = (chunks: Uint8Array[]) => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
};

export const isRealtimeStatus = (status: number) => status >= 0xf8 && status <= 0xff;

export const buildSmfFromMessages = (
    messages: MidiMessageEvent[],
    opts?: { ticksPerQuarter?: number; bpm?: number }
): Uint8Array => {
    const tpq = opts?.ticksPerQuarter ?? 480;
    const bpm = opts?.bpm ?? 120;
    const usPerQuarter = Math.round(60_000_000 / bpm);
    const ticksPerMs = (tpq * bpm) / 60_000;

    const msgs = messages
        .slice()
        .sort((a, b) => (a.tMs === b.tMs ? 0 : a.tMs < b.tMs ? -1 : 1));

    const trackChunks: Uint8Array[] = [];

    // Tempo meta at start
    trackChunks.push(
        vlq(0),
        new Uint8Array([
            0xff, 0x51, 0x03,
            (usPerQuarter >> 16) & 0xff,
            (usPerQuarter >> 8) & 0xff,
            usPerQuarter & 0xff
        ])
    );

    let lastMs = msgs.length ? msgs[0].tMs : 0;

    for (let i = 0; i < msgs.length; i++) {
        const { tMs, data } = msgs[i];
        if (!data || data.length === 0) continue;

        const status = data[0];
        if (isRealtimeStatus(status) && data.length === 1) continue;

        const deltaMs = i === 0 ? 0 : Math.max(0, tMs - lastMs);
        lastMs = tMs;

        const deltaTicks = clampInt(Math.round(deltaMs * ticksPerMs), 0, 0x0fffffff);
        trackChunks.push(vlq(deltaTicks));

        if (status === 0xf0 || status === 0xf7) {
            const payload = data.slice(1);
            trackChunks.push(new Uint8Array([status]), vlq(payload.length), payload);
        } else {
            trackChunks.push(data);
        }
    }

    // End-of-track
    trackChunks.push(vlq(0), new Uint8Array([0xff, 0x2f, 0x00]));

    const trackData = concatBytes(trackChunks);

    const header = concatBytes([
        new Uint8Array([0x4d, 0x54, 0x68, 0x64]), // MThd
        u32be(6),
        u16be(0),
        u16be(1),
        u16be(tpq),
    ]);

    const track = concatBytes([
        new Uint8Array([0x4d, 0x54, 0x72, 0x6b]), // MTrk
        u32be(trackData.length),
        trackData,
    ]);

    return concatBytes([header, track]);
};
