"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const parseNLToOMA_1 = require("../src/tools/parseNLToOMA");
describe('parseNLToOMA reconstruction detection', () => {
    test('detects harmonic reduction from user prompt', () => {
        const result = (0, parseNLToOMA_1.parseNLToOMA)({ text: 'Spiele die harmonische Reduktion von Takt 1 bis 3' });
        expect(result.targetReconId).toBe('harmonic_reduction');
        expect(result.intent).toBe('play');
    });
    test('detects full reconstruction from user prompt', () => {
        const result = (0, parseNLToOMA_1.parseNLToOMA)({ text: 'Spiele die vollständige Fassung ab Takt 5' });
        expect(result.targetReconId).toBe('reconstruction');
        expect(result.intent).toBe('play');
    });
    test('defaults to no specific reconstruction when unclear', () => {
        const result = (0, parseNLToOMA_1.parseNLToOMA)({ text: 'Spiele ab dem Anfang' });
        expect(result.targetReconId).toBeUndefined();
        expect(result.intent).toBe('play');
    });
    test('detects explicit swap intent', () => {
        const result = (0, parseNLToOMA_1.parseNLToOMA)({ text: 'Wechsle zur harmonischen Reduktion' });
        expect(result.targetReconId).toBe('harmonic_reduction');
        expect(result.intent).toBe('swap');
    });
    test('handles play intent with implied reconstruction without switching', () => {
        const result = (0, parseNLToOMA_1.parseNLToOMA)({ text: 'Harmonische Reduktion von Takt 2 bis 4' });
        expect(result.targetReconId).toBe('harmonic_reduction');
        expect(result.intent).toBe('play');
    });
});
//# sourceMappingURL=parseNLToOMA.test.js.map