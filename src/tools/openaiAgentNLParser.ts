/**
 * OpenAI Agent SDK wrapper for intelligent NL parsing
 * 
 * This service replaces the primitive string-matching approach in parseNLToOMA
 * with OpenAI's Agent/Assistant capabilities for:
 * 1. Sophisticated musical location parsing with MEI introspection
 * 2. Intelligent modifier interpretation
 * 3. Complex natural language understanding
 */

import OpenAI from 'openai';
import { ParseNLToOMAInput, ParseNLToOMAOutput, OMA, ModifierSpec } from '../types';
import { VerovioWrapper } from '../utils/verovioWrapper';
import * as fs from 'fs';
import * as path from 'path';

export class OpenAIAgentNLParser {
  private openai: OpenAI;
  private assistantId?: string;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY
    });
  }

  /**
   * Initialize or get the OpenAI Assistant for NL parsing
   */
  private async getOrCreateAssistant(): Promise<string> {
    if (this.assistantId) {
      return this.assistantId;
    }

    const assistant = await this.openai.beta.assistants.create({
      name: "Virtual Grünfeld Music Parser",
      instructions: `You are an expert assistant for parsing musical natural language into structured formats.

Your role is to parse German and English natural language requests about musical locations, gestures, and performance modifiers into structured JSON format.

Key capabilities:
1. **Musical Location Parsing**: Convert phrases like "Auftakt zu Takt 2", "play the anacrusis gesture towards the high f in bar 2", "T.1-3" into OMA (Open Music Addressability) format
2. **Modifier Interpretation**: Understand performance modifiers like "übertreiben die Dynamik", "langsamer", "ohne Rubato" and convert to structured JSON
3. **Intent Detection**: Determine if the user wants to "play", "modify", "stop", or "swap" reconstructions

OMA Format:
{
  "from": { "measure": number, "beat"?: number, "beatOffset"?: number },
  "to"?: { "measure": number, "beat"?: number, "beatOffset"?: number }
}

Modifier Format:
{
  "exaggerate"?: { "dynamics"?: number, "rubato"?: number, "articulation"?: number }, // 0..2 scale
  "tempo"?: { "factor": number }, // 0.8 = slower, 1.2 = faster
  "hide"?: { "dynamics"?: boolean, "rubato"?: boolean, "articulation"?: boolean }
}

Intent values: "play", "modify", "stop", "swap"

Always respond with valid JSON in this format:
{
  "oma"?: OMA,
  "intent": string,
  "modifiers"?: ModifierSpec,
  "targetReconId"?: string
}`,
      model: "gpt-4-turbo-preview",
      tools: [
        {
          type: "function",
          function: {
            name: "introspect_mei",
            description: "Introspect MEI file to find specific musical elements when complex location queries are needed",
            parameters: {
              type: "object",
              properties: {
                reconId: {
                  type: "string",
                  description: "Reconstruction ID to introspect"
                },
                query: {
                  type: "string", 
                  description: "What to search for (e.g., 'high f', 'anacrusis gesture')"
                }
              },
              required: ["reconId", "query"]
            }
          }
        }
      ]
    });

    this.assistantId = assistant.id;
    return assistant.id;
  }

  /**
   * Parse natural language text using OpenAI Agent SDK
   */
  async parseNaturalLanguage(input: ParseNLToOMAInput): Promise<ParseNLToOMAOutput> {
    try {
      const assistantId = await this.getOrCreateAssistant();

      // Create a thread for this parsing request
      const thread = await this.openai.beta.threads.create({
        messages: [
          {
            role: "user",
            content: `Parse this musical natural language request: "${input.text}"`
          }
        ]
      });

      // Run the assistant
      const run = await this.openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId
      });

      // Wait for completion and handle tool calls
      const result = await this.waitForRunCompletion(thread.id, run.id);
      
      return this.parseAssistantResponse(result, input.text);

    } catch (error) {
      console.error('OpenAI Agent parsing failed:', error);
      // Fallback to the original parseNLToOMA implementation
      return this.fallbackParsing(input);
    }
  }

  /**
   * Wait for the OpenAI run to complete and handle any tool calls
   */
  private async waitForRunCompletion(threadId: string, runId: string): Promise<any> {
    let run = await this.openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });

    while (run.status === 'in_progress' || run.status === 'queued') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      run = await this.openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });
      
      // Handle tool calls if needed
      if (run.status === 'requires_action' && run.required_action?.type === 'submit_tool_outputs') {
        const toolOutputs = await this.handleToolCalls(run.required_action.submit_tool_outputs.tool_calls);
        
        run = await this.openai.beta.threads.runs.submitToolOutputs(runId, {
          thread_id: threadId,
          tool_outputs: toolOutputs
        });
      }
    }

    if (run.status === 'completed') {
      const messages = await this.openai.beta.threads.messages.list(threadId);
      return messages.data[0]; // Get the latest assistant message
    } else {
      throw new Error(`OpenAI run failed with status: ${run.status}`);
    }
  }

  /**
   * Handle tool calls for MEI introspection
   */
  private async handleToolCalls(toolCalls: any[]): Promise<Array<{ tool_call_id: string; output: string }>> {
    const outputs: Array<{ tool_call_id: string; output: string }> = [];

    for (const toolCall of toolCalls) {
      if (toolCall.function.name === 'introspect_mei') {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await this.introspectMEI(args.reconId, args.query);
        
        outputs.push({
          tool_call_id: toolCall.id,
          output: JSON.stringify(result)
        });
      }
    }

    return outputs;
  }

  /**
   * Introspect MEI file for complex musical queries
   */
  private async introspectMEI(reconId: string, query: string): Promise<any> {
    try {
      const meiPath = path.join(process.cwd(), 'assets', reconId, 'score.mei');
      
      if (!fs.existsSync(meiPath)) {
        return { error: `MEI file not found for reconstruction: ${reconId}` };
      }

      const meiContent = fs.readFileSync(meiPath, 'utf8');
      
      // Basic MEI introspection - this could be enhanced further
      const analysis = {
        totalMeasures: this.countMeasures(meiContent),
        noteInfo: this.analyzeNotes(meiContent, query),
        structuralElements: this.findStructuralElements(meiContent)
      };

      return analysis;

    } catch (error) {
      return { error: `MEI introspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Count total measures in MEI
   */
  private countMeasures(meiContent: string): number {
    const measureMatches = meiContent.match(/<measure[^>]*>/g);
    return measureMatches ? measureMatches.length : 0;
  }

  /**
   * Analyze notes based on query
   */
  private analyzeNotes(meiContent: string, query: string): Array<{ pitch: string; duration: any; position: any }> {
    const notes: Array<{ pitch: string; duration: any; position: any }> = [];
    const notePattern = /<note[^>]*\s+pname=["']([^"']+)["'][^>]*\s+oct=["']([^"']+)["'][^>]*(?:\s+dur=["']([^"']+)["'])?[^>]*>/g;
    
    let match;
    while ((match = notePattern.exec(meiContent)) !== null) {
      const [, pname, oct, dur] = match;
      notes.push({
        pitch: `${pname}${oct}`,
        duration: dur,
        position: match.index
      });
    }

    // Filter notes based on query
    if (query.toLowerCase().includes('high')) {
      return notes.filter(note => parseInt(note.pitch.slice(-1)) >= 5);
    } else if (query.toLowerCase().includes('anacrusis') || query.toLowerCase().includes('auftakt')) {
      // Look for notes before the first complete measure
      return notes.slice(0, 4); // Approximate anacrusis
    }

    return notes.slice(0, 10); // Return first 10 notes as default
  }

  /**
   * Find structural elements like time signatures, key signatures
   */
  private findStructuralElements(meiContent: string): any {
    return {
      timeSig: this.extractAttribute(meiContent, 'scoreDef', 'meter.count'),
      keySig: this.extractAttribute(meiContent, 'scoreDef', 'key.sig'),
      tempo: this.extractAttribute(meiContent, 'tempo', 'midi.bpm')
    };
  }

  /**
   * Extract attribute from MEI element
   */
  private extractAttribute(meiContent: string, element: string, attribute: string): string | null {
    const pattern = new RegExp(`<${element}[^>]*\\s+${attribute}=["']([^"']+)["']`, 'i');
    const match = meiContent.match(pattern);
    return match ? match[1] : null;
  }

  /**
   * Parse the assistant's response into ParseNLToOMAOutput format
   */
  private parseAssistantResponse(message: any, originalText: string): ParseNLToOMAOutput {
    try {
      const content = message.content[0]?.text?.value;
      if (!content) {
        throw new Error('No content in assistant response');
      }

      // Try to parse as JSON
      const parsed = JSON.parse(content);
      
      // Validate and return the response
      return {
        oma: parsed.oma,
        intent: parsed.intent || 'play',
        modifiers: parsed.modifiers,
        targetReconId: parsed.targetReconId
      };

    } catch (error) {
      console.error('Failed to parse assistant response:', error);
      return this.fallbackParsing({ text: originalText });
    }
  }

  /**
   * Fallback to original string-matching parsing when OpenAI fails
   */
  private fallbackParsing(input: ParseNLToOMAInput): ParseNLToOMAOutput {
    // Inline the original primitive parsing logic to avoid circular imports
    const { text } = input;
    const lowerText = text.toLowerCase();

    // Intent detection
    if (lowerText.includes('danke') || lowerText.includes('stop') || lowerText.includes('halt')) {
      return { intent: "stop" };
    }

    // Check for explicit swap intent (must contain switching language)
    if ((lowerText.includes('wechsle') || lowerText.includes('schalte') || 
         lowerText.includes('switch') || lowerText.includes('change')) &&
        (lowerText.includes('reduktion') || lowerText.includes('harmonisch'))) {
      return { 
        intent: "swap",
        targetReconId: "harmonic_reduction"
      };
    }

    if ((lowerText.includes('wechsle') || lowerText.includes('schalte') || 
         lowerText.includes('switch') || lowerText.includes('change')) &&
        (lowerText.includes('vollständig') || lowerText.includes('original'))) {
      return { 
        intent: "swap",
        targetReconId: "reconstruction"
      };
    }

    // Default to beginning if no specific location found
    return {
      oma: { from: { measure: 1, beat: 1 } },
      intent: "play"
    };
  }
}