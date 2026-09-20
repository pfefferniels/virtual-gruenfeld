import { describe, expect, it } from 'vitest';
import { createTestTiming } from './clock';
import { createFakeMidiPort, findDisklavierOutput, webMidiPort } from './port';

type Sent = { data: number[]; timestamp?: number };

const stubOutput = (id: string, name: string | null, sent: Sent[] = []) =>
    ({
        id,
        name,
        send: (data: number[], timestamp?: number) => sent.push({ data, timestamp }),
    }) as unknown as MIDIOutput;

const stubAccess = (outputs: readonly MIDIOutput[]) =>
    ({ outputs: new Map(outputs.map((output) => [output.id, output])) }) as unknown as MIDIAccess;

describe('the real port', () => {
    it('passes the bytes and the timestamp through to the instrument', () => {
        const sent: Sent[] = [];
        webMidiPort(stubOutput('a', 'Disklavier', sent)).send(new Uint8Array([0x90, 60, 64]), 1234);
        expect(sent).toEqual<Sent[]>([{ data: [0x90, 60, 64], timestamp: 1234 }]);
    });

    it('leaves the timestamp off when the message is wanted now', () => {
        const sent: Sent[] = [];
        webMidiPort(stubOutput('a', null, sent)).send(new Uint8Array([0xb0, 64, 0]));
        expect(sent[0].timestamp).toBeUndefined();
    });
});

describe('finding the instrument', () => {
    const generic = stubOutput('1', 'USB MIDI Interface');
    const piano = stubOutput('2', 'Yamaha Disklavier ENSPIRE');

    it('takes the output it is given by id', () => {
        expect(findDisklavierOutput(stubAccess([generic, piano]), '1')).toBe(generic);
    });

    it('prefers one that says what it is', () => {
        expect(findDisklavierOutput(stubAccess([generic, piano]))).toBe(piano);
    });

    it('falls back to the first output, since the name is not to be relied on', () => {
        expect(findDisklavierOutput(stubAccess([generic]))).toBe(generic);
    });

    it('answers null rather than guessing when there is nothing to answer on', () => {
        expect(findDisklavierOutput(stubAccess([]))).toBeNull();
        expect(findDisklavierOutput(stubAccess([generic]), 'missing')).toBeNull();
    });
});

describe('the fake', () => {
    it('records what was sent, when it was wanted and when the page let go of it', () => {
        const timing = createTestTiming();
        const port = createFakeMidiPort(timing.now);

        port.send(new Uint8Array([0x90, 60, 64]), 500);
        timing.advance(100);
        port.send(new Uint8Array([0x80, 60, 0]));

        expect(port.sent.map(({ atMs, handedOverAtMs }) => [atMs, handedOverAtMs])).toEqual([
            [500, 0],
            [100, 100],
        ]);
    });

    it('copies the bytes, so a caller reusing its buffer cannot rewrite history', () => {
        const port = createFakeMidiPort(() => 0);
        const data = new Uint8Array([0x90, 60, 64]);
        port.send(data);
        data[2] = 0;
        expect([...port.sent[0].data]).toEqual([0x90, 60, 64]);
    });
});
