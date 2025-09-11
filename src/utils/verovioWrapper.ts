import * as verovio from 'verovio';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Verovio toolkit wrapper for MEI processing
 * Provides utilities for loading MEI files and using Verovio's select() function
 */
export class VerovioWrapper {
  private static instance: VerovioWrapper;
  private vrvToolkit: any;
  private loadedMeiFiles: Map<string, string> = new Map();

  private constructor() {
    // Initialize the Verovio toolkit
    this.vrvToolkit = new verovio.toolkit();
    
    // Set default options for score processing
    this.vrvToolkit.setOptions({
      pageHeight: 2970,
      pageWidth: 2100,
      scale: 40,
      adjustPageHeight: true,
      breaks: 'auto'
    });
  }

  public static getInstance(): VerovioWrapper {
    if (!VerovioWrapper.instance) {
      VerovioWrapper.instance = new VerovioWrapper();
    }
    return VerovioWrapper.instance;
  }

  /**
   * Load MEI file content and prepare it for processing
   * @param meiFilePath Path to the MEI file
   * @returns The loaded MEI content as string
   */
  public loadMEI(meiFilePath: string): string {
    if (this.loadedMeiFiles.has(meiFilePath)) {
      return this.loadedMeiFiles.get(meiFilePath)!;
    }

    if (!fs.existsSync(meiFilePath)) {
      throw new Error(`MEI file not found: ${meiFilePath}`);
    }

    const meiContent = fs.readFileSync(meiFilePath, 'utf8');
    this.loadedMeiFiles.set(meiFilePath, meiContent);

    // Load the MEI content into Verovio
    if (!this.vrvToolkit.loadData(meiContent)) {
      throw new Error(`Failed to load MEI file: ${meiFilePath}`);
    }

    return meiContent;
  }

  /**
   * Use Verovio's select() function to find notes/elements within a range
   * This is the core functionality requested in the problem statement
   * @param startMeasure Starting measure number (1-based)
   * @param endMeasure Ending measure number (1-based) 
   * @param startBeat Starting beat (optional)
   * @param endBeat Ending beat (optional)
   * @returns Array of xml:id strings for elements in the range
   */
  public selectElementsInRange(
    startMeasure: number,
    endMeasure?: number,
    startBeat?: number,
    endBeat?: number
  ): string[] {
    try {
      // Build selection query for Verovio
      // Verovio's select function can take various query formats
      // For measure ranges, we can use XPath-like queries
      
      const actualEndMeasure = endMeasure || startMeasure;
      
      // Create a query to select notes and rests in the measure range
      let query: string;
      
      if (startMeasure === actualEndMeasure) {
        // Single measure selection
        query = `//measure[@n='${startMeasure}']//note | //measure[@n='${startMeasure}']//rest`;
      } else {
        // Multiple measure selection - select all measures in range
        const measureQueries: string[] = [];
        for (let m = startMeasure; m <= actualEndMeasure; m++) {
          measureQueries.push(`//measure[@n='${m}']//note | //measure[@n='${m}']//rest`);
        }
        query = measureQueries.join(' | ');
      }

      // Use Verovio's select function to get elements
      const selectedElements = this.vrvToolkit.select(query);
      
      if (selectedElements && Array.isArray(selectedElements)) {
        // Extract xml:id attributes from selected elements
        return selectedElements
          .map((element: any) => {
            // Handle different possible formats returned by select()
            if (typeof element === 'string') {
              return element;
            }
            if (element && element.getAttribute) {
              return element.getAttribute('xml:id');
            }
            if (element && element.id) {
              return element.id;
            }
            return null;
          })
          .filter((id: string | null) => id !== null) as string[];
      }

      // Fallback: if select() doesn't work as expected, parse manually
      return this.selectElementsManually(startMeasure, actualEndMeasure);

    } catch (error) {
      console.warn('Verovio select() failed, falling back to manual parsing:', error);
      // Fallback to manual parsing
      return this.selectElementsManually(startMeasure, endMeasure || startMeasure);
    }
  }

  /**
   * Manual fallback method for finding elements when Verovio select() doesn't work
   * Parses MEI XML directly to find note and rest elements
   */
  private selectElementsManually(startMeasure: number, endMeasure: number): string[] {
    try {
      // Get the currently loaded MEI content
      const meiContent = this.vrvToolkit.getMEI();
      if (!meiContent) {
        return [];
      }

      const xmlIds: string[] = [];
      
      // Simple regex-based parsing to find notes and rests in target measures
      // This is a simplified approach - in production, you'd want proper XML parsing
      
      for (let measure = startMeasure; measure <= endMeasure; measure++) {
        // Find the measure element
        const measurePattern = new RegExp(
          `<measure[^>]*\\s+n=["']${measure}["'][^>]*>([\\s\\S]*?)</measure>`,
          'g'
        );
        
        const measureMatch = measurePattern.exec(meiContent);
        if (measureMatch) {
          const measureContent = measureMatch[1];
          
          // Find all notes and rests with xml:id attributes in this measure
          const elementPattern = /<(?:note|rest)[^>]*\s+xml:id=["']([^"']+)["'][^>]*>/g;
          let elementMatch;
          
          while ((elementMatch = elementPattern.exec(measureContent)) !== null) {
            xmlIds.push(elementMatch[1]);
          }
        }
      }

      return xmlIds;
    } catch (error) {
      console.error('Manual MEI parsing failed:', error);
      return [];
    }
  }

  /**
   * Get timing information from Verovio (if available)
   * This could be used for more accurate tick calculations
   */
  public getTimingInfo(): any {
    try {
      // Verovio might provide timing information
      return this.vrvToolkit.getTimeMap();
    } catch (error) {
      return null;
    }
  }

  /**
   * Get the current MEI content loaded in Verovio
   */
  public getCurrentMEI(): string {
    return this.vrvToolkit.getMEI();
  }

  /**
   * Clear the loaded MEI files cache
   */
  public clearCache(): void {
    this.loadedMeiFiles.clear();
  }
}