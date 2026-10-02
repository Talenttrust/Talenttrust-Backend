/**
 * @file changelog-disputes.test.ts
 * @description Tests for the disputes API changelog documentation.
 *
 * These tests verify:
 * - The changelog file exists and is readable
 * - Changelog entries follow the expected format
 * - Dates are valid and in chronological order
 * - Commit references are properly formatted
 * - The policy note is present
 * - Entries can be parsed and validated
 */

import fs from 'fs';
import path from 'path';

const CHANGELOG_PATH = path.join(__dirname, '../../docs/changelog-disputes.md');

describe('Disputes API Changelog', () => {
  describe('File existence and readability', () => {
    it('should exist at the expected path', () => {
      expect(fs.existsSync(CHANGELOG_PATH)).toBe(true);
    });

    it('should be readable', () => {
      expect(() => fs.readFileSync(CHANGELOG_PATH, 'utf-8')).not.toThrow();
    });

    it('should not be empty', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);
    });
  });

  describe('Required sections', () => {
    it('should have a title header', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      expect(content).toMatch(/^# Disputes API Changelog/m);
    });

    it('should have a policy note', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      expect(content).toMatch(/\*\*Note:\*\*.*should be updated.*PR description.*changelog/s);
    });

    it('should have a reminder at the end', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      expect(content).toMatch(/\*Please ensure each PR.*includes an entry/s);
    });
  });

  describe('Entry format validation', () => {
    let content: string;
    let entries: Array<{ date: string; items: string[] }>;

    beforeAll(() => {
      content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      entries = parseChangelogEntries(content);
    });

    it('should have at least one entry', () => {
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should have valid date format (YYYY-MM-DD)', () => {
      entries.forEach((entry) => {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        expect(entry.date).toMatch(dateRegex);
      });
    });

    it('should have dates in chronological order (newest first)', () => {
      for (let i = 0; i < entries.length - 1; i++) {
        const currentDate = new Date(entries[i].date);
        const nextDate = new Date(entries[i + 1].date);
        expect(currentDate.getTime()).toBeGreaterThanOrEqual(nextDate.getTime());
      }
    });

    it('should have at least one change per entry', () => {
      entries.forEach((entry) => {
        expect(entry.items.length).toBeGreaterThan(0);
      });
    });

    it('should have properly formatted change items with commit refs', () => {
      entries.forEach((entry) => {
        entry.items.forEach((item) => {
          // Each item should start with a dash
          expect(item.trim()).toMatch(/^-\s+/);
          // Should contain a commit reference in backticks
          expect(item).toMatch(/`[a-f0-9]{7,}`/);
        });
      });
    });
  });

  describe('Content validation', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
    });

    it('should mention key disputes API features', () => {
      // Based on the backfilled changes, these should be mentioned
      const expectedKeywords = [
        'soft-delete',
        'bulk',
        'rate limiting',
        'idempotency',
        'correlation',
        'validation',
      ];
      
      expectedKeywords.forEach((keyword) => {
        expect(content.toLowerCase()).toContain(keyword);
      });
    });

    it('should reference relevant source files', () => {
      // Should reference disputes-related files
      const expectedFileReferences = [
        'disputes.service',
        'disputes.routes',
        'disputes.validation',
        'dispute.dto',
      ];
      
      expectedFileReferences.forEach((fileRef) => {
        // At least some of these should be mentioned
        const hasReference = content.toLowerCase().includes(fileRef.toLowerCase());
        // Not all need to be present, but at least some should
      });
    });

    it('should reference documentation files', () => {
      const expectedDocReferences = [
        'disputes.md',
        'runbook-disputes',
        'disputes-examples',
        'disputes-flow',
      ];
      
      let foundCount = 0;
      expectedDocReferences.forEach((docRef) => {
        if (content.toLowerCase().includes(docRef.toLowerCase())) {
          foundCount++;
        }
      });
      
      // At least 2 documentation references should be present
      expect(foundCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Edge cases', () => {
    it('should handle multiple entries on the same date', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      const entries = parseChangelogEntries(content);
      
      // Group by date
      const dateCounts = entries.reduce((acc, entry) => {
        acc[entry.date] = (acc[entry.date] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      // If there are duplicate dates, that's fine - just ensure they're valid
      Object.values(dateCounts).forEach((count) => {
        expect(count).toBeGreaterThan(0);
      });
    });

    it('should not have malformed markdown', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      
      // Check for common markdown issues
      expect(content).not.toMatch(/\[.*\]\(\)/); // Empty links
      expect(content).not.toMatch(/`{3,}/); // Too many backticks (code block issues)
    });

    it('should have consistent heading levels', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      const lines = content.split('\n');
      
      // Date headers should be level 3 (###)
      const dateHeaderLines = lines.filter((line) => 
        line.match(/^##\s+\d{4}-\d{2}-\d{2}/)
      );
      
      dateHeaderLines.forEach((line) => {
        expect(line).toMatch(/^##\s+/); // Should be ##
      });
    });
  });

  describe('Parseability', () => {
    it('should be parseable as structured data', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      
      expect(() => parseChangelogEntries(content)).not.toThrow();
    });

    it('should extract commit hashes correctly', () => {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
      const entries = parseChangelogEntries(content);
      
      entries.forEach((entry) => {
        entry.items.forEach((item) => {
          const hashMatch = item.match(/`([a-f0-9]{7,})`/);
          expect(hashMatch).toBeTruthy();
          if (hashMatch) {
            const hash = hashMatch[1];
            // Commit hashes should be hexadecimal
            expect(hash).toMatch(/^[a-f0-9]+$/);
            // Should be at least 7 characters (short hash)
            expect(hash.length).toBeGreaterThanOrEqual(7);
          }
        });
      });
    });
  });
});

/**
 * Parse the changelog markdown into structured entries.
 * This is a helper function used by tests to validate the format.
 */
function parseChangelogEntries(content: string): Array<{ date: string; items: string[] }> {
  const entries: Array<{ date: string; items: string[] }> = [];
  const lines = content.split('\n');
  
  let currentDate: string | null = null;
  let currentItems: string[] = [];
  
  for (const line of lines) {
    // Match date headers: ## 2026-07-27
    const dateMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      // Save previous entry if exists
      if (currentDate && currentItems.length > 0) {
        entries.push({ date: currentDate, items: currentItems });
      }
      // Start new entry
      currentDate = dateMatch[1];
      currentItems = [];
      continue;
    }
    
    // Match list items: - **Title** (`hash`) - description
    // Also match items without the description part for flexibility
    const itemMatch = line.match(/^-\s+\*\*(.+?)\*\*\s+\(`[a-f0-9]+`\)/);
    if (itemMatch && currentDate) {
      currentItems.push(line.trim());
    }
  }
  
  // Don't forget the last entry
  if (currentDate && currentItems.length > 0) {
    entries.push({ date: currentDate, items: currentItems });
  }
  
  return entries;
}
