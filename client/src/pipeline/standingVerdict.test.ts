import { describe, expect, it } from 'vitest';
import {
    createVerdictStore,
    LIVE_POLICY,
    type Correction,
    type Policy,
    type Standing,
    type VerdictStore,
} from './standingVerdict';

type Plan = { mode: string };

const standing = (interrupt: number, landedAtMs: number, dimension = 'tempo'): Standing<Plan> => ({
    verdict: { interrupt, dimension, severity: 2.8, exaggeration: 1.4 },
    plan: { mode: 'exaggerated' },
    range: { from: 11520, to: 17280 },
    landedAtMs,
});

/** Hands off the keys for longer than the policy's silence, so only the verdict is under test. */
const SILENT = LIVE_POLICY.silenceMs + 1;

/** The shipped policy is what is under test; a named one makes that explicit. */
const policy: Policy = LIVE_POLICY;

const freshStore = (): VerdictStore<Plan> => createVerdictStore<Plan>(policy);

describe('persistence', () => {
    it('holds a dimension back until it has survived consecutive windows', () => {
        const store = freshStore();
        expect(store.observe(['tempo'])).toEqual([]);
        expect(store.observe(['tempo'])).toEqual(['tempo']);
    });

    it('forgets a dimension that does not reappear, so noise never accumulates', () => {
        const store = freshStore();
        store.observe(['tempo']);
        store.observe(['dynamics']);
        expect(store.observe(['tempo'])).toEqual([]);
    });

    it('counts dimensions apart', () => {
        const store = freshStore();
        store.observe(['tempo', 'dynamics']);
        expect(store.observe(['tempo'])).toEqual(['tempo']);
    });
});

describe('the trigger', () => {
    it('stays silent below the fire threshold', () => {
        const store = freshStore();
        store.record(standing(LIVE_POLICY.fireAbove - 0.01, 0));
        expect(store.due(100, SILENT)).toBeNull();
    });

    it('fires above it', () => {
        const store = freshStore();
        store.record(standing(LIVE_POLICY.fireAbove + 0.01, 0));
        expect(store.due(100, SILENT)).not.toBeNull();
    });

    it('holds through the dead band once armed, so Jev’s ±0.05 cannot chatter it', () => {
        const store = freshStore();
        store.record(standing(0.55, 0));
        expect(store.due(100, SILENT)).not.toBeNull();

        // Below the fire threshold but inside the band: it stays armed rather than flickering.
        store.record(standing(0.50, 100));
        expect(store.due(200, SILENT)).not.toBeNull();

        store.record(standing(0.40, 200));
        expect(store.due(300, SILENT)).toBeNull();
    });

    it('says nothing when there is nothing to demonstrate', () => {
        const store = freshStore();
        store.record(standing(0.9, 0, 'none'));
        expect(store.due(100, SILENT)).toBeNull();
    });
});

describe('when he may come in', () => {
    it('waits for the hands to leave the keys', () => {
        const store = freshStore();
        store.record(standing(0.6, 0));
        expect(store.due(100, 200)).toBeNull();
        expect(store.due(100, SILENT)).not.toBeNull();
    });

    it('will not act on a verdict that has not landed yet', () => {
        const store = freshStore();
        store.record(standing(0.6, 500));
        expect(store.due(400, SILENT)).toBeNull();
        expect(store.due(600, SILENT)).not.toBeNull();
    });

    it('drops a verdict the student has played past', () => {
        const store = freshStore();
        store.record(standing(0.6, 0));
        expect(store.due(LIVE_POLICY.ttlMs + 1, SILENT)).toBeNull();
    });

    it('does not come in twice inside the refractory period', () => {
        const store = freshStore();
        const first = standing(0.6, 0);
        store.record(first);
        const due = store.due(100, SILENT);
        expect(due).not.toBeNull();
        store.committed(due!, 100, 5);

        store.record(standing(0.9, 200));
        expect(store.due(300, SILENT)).toBeNull();
        store.record(standing(0.9, LIVE_POLICY.refractoryMs + 100));
        expect(store.due(LIVE_POLICY.refractoryMs + 200, SILENT)).not.toBeNull();
    });
});

describe('what he remembers', () => {
    it('records the point once, and counts it when it is made again', () => {
        const store = freshStore();
        const commit = (atMs: number) => {
            store.record(standing(0.6, atMs));
            const due = store.due(atMs + 10, SILENT);
            expect(due).not.toBeNull();
            store.committed(due!, atMs + 10, 5);
        };

        commit(0);
        expect(store.corrections()).toEqual<Correction[]>([{ bar: 5, dimension: 'tempo', times: 1 }]);

        commit(LIVE_POLICY.refractoryMs + 100);
        expect(store.corrections()).toEqual([{ bar: 5, dimension: 'tempo', times: 2 }]);
    });

    it('keeps bars apart', () => {
        const store = freshStore();
        store.record(standing(0.6, 0));
        store.committed(store.due(10, SILENT)!, 10, 5);
        store.record(standing(0.6, LIVE_POLICY.refractoryMs + 100));
        store.committed(store.due(LIVE_POLICY.refractoryMs + 110, SILENT)!, LIVE_POLICY.refractoryMs + 110, 7);

        expect(store.corrections()).toEqual([
            { bar: 5, dimension: 'tempo', times: 1 },
            { bar: 7, dimension: 'tempo', times: 1 },
        ]);
    });

    it('clears the standing verdict once acted on, so it cannot fire twice', () => {
        const store = freshStore();
        store.record(standing(0.6, 0));
        store.committed(store.due(10, SILENT)!, 10, 5);
        expect(store.due(20, SILENT)).toBeNull();
    });
});
