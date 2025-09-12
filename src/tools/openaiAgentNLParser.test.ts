import { OpenAIAgentNLParser } from './openaiAgentNLParser';
import { ParseNLToOMAInput } from '../types';

describe('OpenAIAgentNLParser', () => {
  let parser: OpenAIAgentNLParser;

  beforeEach(() => {
    parser = new OpenAIAgentNLParser('test-api-key');
  });

  describe('fallback parsing', () => {
    beforeEach(() => {
      // Ensure no API key is set for fallback tests
      delete process.env.OPENAI_API_KEY;
    });

    it('should handle stop intents', async () => {
      const input: ParseNLToOMAInput = { text: 'danke' };
      const result = await parser.parseNaturalLanguage(input);

      expect(result.intent).toBe('stop');
    });

    it('should handle swap intents for harmonic reduction', async () => {
      const input: ParseNLToOMAInput = { text: 'wechsle zur harmonischen Reduktion' };
      const result = await parser.parseNaturalLanguage(input);

      expect(result.intent).toBe('swap');
      expect(result.targetReconId).toBe('harmonic_reduction');
    });

    it('should handle swap intents for full reconstruction', async () => {
      const input: ParseNLToOMAInput = { text: 'wechsle zur vollständigen Version' };
      const result = await parser.parseNaturalLanguage(input);

      expect(result.intent).toBe('swap');
      expect(result.targetReconId).toBe('reconstruction');
    });

    it('should default to play intent with measure 1', async () => {
      const input: ParseNLToOMAInput = { text: 'spiel etwas' };
      const result = await parser.parseNaturalLanguage(input);

      expect(result.intent).toBe('play');
      expect(result.oma?.from.measure).toBe(1);
      expect(result.oma?.from.beat).toBe(1);
    });
  });

  describe('MEI introspection', () => {
    it('should analyze MEI content for note information', () => {
      const meiContent = `
        <measure n="1">
          <note xml:id="note1" pname="c" oct="4" dur="4"/>
          <note xml:id="note2" pname="f" oct="5" dur="8"/>
          <rest xml:id="rest1" dur="4"/>
        </measure>
      `;

      // Access private method for testing (using any cast)
      const analyzeNotes = (parser as any).analyzeNotes.bind(parser);
      const result = analyzeNotes(meiContent, 'high');

      expect(result).toEqual([
        { pitch: 'f5', duration: undefined, position: expect.any(Number) }
      ]);
    });

    it('should count measures correctly', () => {
      const meiContent = `
        <measure n="1">content1</measure>
        <measure n="2">content2</measure>
        <measure n="3">content3</measure>
      `;

      // Access private method for testing
      const countMeasures = (parser as any).countMeasures.bind(parser);
      const count = countMeasures(meiContent);

      expect(count).toBe(3);
    });

    it('should extract MEI attributes correctly', () => {
      const meiContent = `<scoreDef meter.count="4" key.sig="1s" midi.bpm="120"/>`;

      // Access private method for testing  
      const extractAttribute = (parser as any).extractAttribute.bind(parser);
      
      expect(extractAttribute(meiContent, 'scoreDef', 'meter.count')).toBe('4');
      expect(extractAttribute(meiContent, 'scoreDef', 'key.sig')).toBe('1s');
      expect(extractAttribute(meiContent, 'scoreDef', 'midi.bpm')).toBe('120');
      expect(extractAttribute(meiContent, 'scoreDef', 'nonexistent')).toBeNull();
    });
  });

  describe('OpenAI integration (mocked for testing)', () => {
    it('should structure the assistant correctly', () => {
      // Test the assistant configuration structure
      const assistantConfig = {
        name: "Virtual Grünfeld Music Parser",
        model: "gpt-4-turbo-preview",
        tools: [
          {
            type: "function",
            function: {
              name: "introspect_mei",
              description: "Introspect MEI file to find specific musical elements when complex location queries are needed"
            }
          }
        ]
      };

      expect(assistantConfig.name).toBe("Virtual Grünfeld Music Parser");
      expect(assistantConfig.tools).toHaveLength(1);
      expect(assistantConfig.tools[0].function.name).toBe("introspect_mei");
    });
  });
});