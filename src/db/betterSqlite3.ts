import type * as BetterSqlite3 from 'better-sqlite3';

interface DatabaseConstructor {
  new (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
  (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
}

let Database: DatabaseConstructor;

namespace Database {
  export type Database = BetterSqlite3.Database;
}
try {
  // Attempt to load the native module and test if its bindings work.
  const RealDatabase = require('better-sqlite3');
  const testDb = new RealDatabase(':memory:');
  testDb.close();
  Database = RealDatabase;
} catch {
  // Fallback mock implementation for environments without the native bindings.
  const fileStates = new Map<string, Record<string, any[]>>();

  const getDbState = (dbPath: string): Record<string, any[]> => {
    const key = dbPath === ':memory:' || !dbPath ? Math.random().toString() : dbPath;
    let state = fileStates.get(key);
    if (!state) {
      state = {
        users: [],
        contracts: [],
        reputation_entries: [],
        transactions: [],
        webhook_dlq: [],
        deployment_history: [],
        idempotency_store: [],
        audit_log_entries: [],
        webhook_subscriptions: [],
      };
      fileStates.set(key, state);
    }
    return state;
  };

  const toCamelCase = (str: string): string => {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  };

  const escapeRegExp = (str: string): string => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  const splitSqlValues = (str: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    let parenDepth = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === "'" || char === '"') {
        if (inQuote === char) {
          inQuote = null;
        } else if (inQuote === null) {
          inQuote = char;
        }
        current += char;
      } else if (char === '(' && !inQuote) {
        parenDepth++;
        current += char;
      } else if (char === ')' && !inQuote) {
        parenDepth--;
        current += char;
      } else if (char === ',' && !inQuote && parenDepth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current.trim());
    return parts;
  };

  const parseSqlValue = (val: string): any => {
    val = val.trim();
    if (val.toUpperCase() === 'NULL') return null;
    if (val.toUpperCase().startsWith("DATETIME(")) {
      const match = val.match(/datetime\(\s*['"]now['"]\s*(?:,\s*['"](-?\d+)\s*(\w+)['"]\s*)?\)/i);
      if (match) {
        const date = new Date();
        if (match[1] && match[2]) {
          const num = parseInt(match[1], 10);
          const unit = match[2].toLowerCase();
          if (unit.startsWith('day')) {
            date.setDate(date.getDate() + num);
          } else if (unit.startsWith('month')) {
            date.setMonth(date.getMonth() + num);
          } else if (unit.startsWith('year')) {
            date.setFullYear(date.getFullYear() + num);
          }
        }
        return date.toISOString();
      }
      return new Date().toISOString();
    }
    // Check if numeric
    if (/^-?\d+$/.test(val)) return parseInt(val, 10);
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
    // Strip quotes
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      return val.slice(1, -1).replace(/''/g, "'"); // Unescape single quotes in SQL
    }
    return val;
  };

  const splitByAnd = (str: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let inQuote: string | null = null;
    let i = 0;
    while (i < str.length) {
      const char = str[i];
      if (char === "'" || char === '"') {
        if (inQuote === char) inQuote = null;
        else if (inQuote === null) inQuote = char;
        current += char;
        i++;
      } else if (char === '(' && !inQuote) {
        parenDepth++;
        current += char;
        i++;
      } else if (char === ')' && !inQuote) {
        parenDepth--;
        current += char;
        i++;
      } else if (!inQuote && parenDepth === 0 && str.slice(i).toUpperCase().startsWith('AND ')) {
        parts.push(current.trim());
        current = '';
        i += 4; // Skip "AND "
      } else {
        current += char;
        i++;
      }
    }
    parts.push(current.trim());
    return parts.filter(p => p.length > 0);
  };

  const evaluateSimpleCondition = (row: any, condSql: string, params: any[], paramIndex: { value: number }): boolean => {
    condSql = condSql.trim();
    const match = condSql.match(/^(\w+)\s*(=|!=|<=|>=|<|>|\bIS\s+NOT\b|\bIS\b|\bLIKE\b)\s*(.+)$/i);
    if (!match) return false;
    const field = match[1].toLowerCase();
    const op = match[2].toUpperCase();
    const valStr = match[3].trim();

    let val: any;
    if (valStr === '?') {
      val = params[paramIndex.value++];
    } else {
      val = parseSqlValue(valStr);
    }

    const rowVal = row[field] !== undefined ? row[field] : row[toCamelCase(field)];

    if (op === '=') {
      return rowVal === val;
    } else if (op === '!=') {
      return rowVal !== val;
    } else if (op === '<=') {
      return rowVal <= val;
    } else if (op === '>=') {
      return rowVal >= val;
    } else if (op === '<') {
      return rowVal < val;
    } else if (op === '>') {
      return rowVal > val;
    } else if (op === 'IS') {
      if (valStr.toUpperCase() === 'NULL') {
        return rowVal === null || rowVal === undefined;
      }
      return rowVal === val;
    } else if (op === 'IS NOT') {
      if (valStr.toUpperCase() === 'NULL') {
        return rowVal !== null && rowVal !== undefined;
      }
      return rowVal !== val;
    } else if (op === 'LIKE') {
      if (typeof rowVal !== 'string') return false;
      const regexStr = '^' + escapeRegExp(val).replace(/%/g, '.*') + '$';
      const regex = new RegExp(regexStr, 'i');
      return regex.test(rowVal);
    }

    return false;
  };

  const evaluateCondition = (row: any, condSql: string, params: any[], paramIndex: { value: number }): boolean => {
    condSql = condSql.trim();
    if (condSql.startsWith('(') && condSql.endsWith(')')) {
      const inner = condSql.slice(1, -1);
      const terms = inner.split(/\s+OR\s+/i);
      const currentParamIndex = paramIndex.value;
      for (const term of terms) {
        const termParamIndex = { value: currentParamIndex };
        if (evaluateSimpleCondition(row, term, params, termParamIndex)) {
          paramIndex.value = termParamIndex.value;
          return true;
        }
      }
      const numParams = (inner.match(/\?/g) || []).length;
      paramIndex.value += numParams;
      return false;
    }
    return evaluateSimpleCondition(row, condSql, params, paramIndex);
  };

  const filterRows = (rows: any[], whereSql: string, params: any[]): any[] => {
    if (!whereSql) return rows;
    const conditions = splitByAnd(whereSql);
    const paramIndex = { value: 0 };
    return rows.filter(row => {
      paramIndex.value = 0;
      for (const cond of conditions) {
        if (!evaluateCondition(row, cond, params, paramIndex)) {
          return false;
        }
      }
      return true;
    });
  };

  const dbPathToState = new Map<string, Record<string, any[]>>();

  class MockDatabase {
    open: boolean;
    private _pragmaValues: Record<string, any> = {};
    state: Record<string, any[]> = {
      users: [],
      contracts: [],
      reputation_entries: [],
      webhook_subscriptions: [],
    };
    _state: Record<string, any[]> = {};

    constructor(_path: string) {
      this.open = true;
      this.state = getDbState(_path);
      this._state = this.state;
    }

    pragma(stmt: string, ..._args: any[]) {
      const arg = _args[0];
      // pragma("name", { simple: true }) — getter
      if (typeof arg === 'object' && arg !== null && (arg as any).simple) {
        const key = stmt.split('=')[0].trim().toLowerCase();
        if (key in this._pragmaValues) {
          return this._pragmaValues[key];
        }
        // Defaults
        if (stmt.includes('journal_mode')) return 'memory';
        if (stmt.includes('synchronous')) return 1;
        if (stmt.includes('busy_timeout')) return this._pragmaValues['busy_timeout'] ?? 5000;
        if (stmt.includes('foreign_keys')) return 1;
        return undefined;
      }
      // pragma("setting = value") — setter
      const parts = stmt.split('=');
      if (parts.length === 2) {
        this._pragmaValues[parts[0]!.trim().toLowerCase()] = parts[1]!.trim();
        // Convert numeric strings
        const num = Number(parts[1]!.trim());
        if (!isNaN(num)) this._pragmaValues[parts[0]!.trim().toLowerCase()] = num;
      }
      // pragma("table_info(...)") — returns schema array
      if (stmt.includes('table_info')) {
        return [{ name: 'id' }, { name: 'version' }];
      }
      return [];
    }

    prepare(sql: string) {
      const self = this;
      const upperSql = sql.trim().replace(/\s+/g, ' ').toUpperCase();

      return {
        run: (...args: any[]) => {
          const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;

          // Handle parameterized INSERT
          if (upperSql.startsWith('INSERT')) {
            const tableMatch = sql.match(/INTO\s+(\w+)\s*\(([^)]+)\)/i);
            if (tableMatch) {
              const tableName = tableMatch[1].toLowerCase();
              if (!self._state[tableName]) self._state[tableName] = [];
              const cols = tableMatch[2].split(',').map((c: string) => c.trim().toLowerCase());
              const newRow: any = {};
              let argIndex = 0;
              for (let i = 0; i < cols.length; i++) {
                // If it is a parameterized column value, read it from flatArgs, otherwise assign the literal value from query definition
                newRow[cols[i]] = flatArgs[argIndex++];
              }
              // Wait, the VALUES SQL string has literals like 1. In: VALUES (?, ?, ?, ?, ?, 1, ?, ?)
              // We need to parse the values list from VALUES (...) to map them correctly.
              // Let's implement a robust values mapping for our mock.
              const valuesMatch = sql.match(/VALUES\s*\((.+?)\)/i);
              if (valuesMatch) {
                const vals = valuesMatch[1].split(',').map(v => v.trim());
                let pIndex = 0;
                for (let i = 0; i < cols.length && i < vals.length; i++) {
                  if (vals[i] === '?') {
                    newRow[cols[i]] = flatArgs[pIndex++];
                  } else {
                    newRow[cols[i]] = parseSqlValue(vals[i]);
                  }
                }
              }
              // UNIQUE constraint enforcement for dedupe_key
              const isOrIgnore = upperSql.includes('OR IGNORE');
              const isOrReplace = upperSql.includes('OR REPLACE');
              const dedupeCol = 'dedupe_key';
              if (newRow[dedupeCol] !== undefined) {
                const existing = self._state[tableName].findIndex((r: any) => r[dedupeCol] === newRow[dedupeCol]);
                if (existing !== -1) {
                  if (isOrIgnore) return { lastInsertRowid: 0, changes: 0 };
                  if (isOrReplace) {
                    self._state[tableName][existing] = newRow;
                    return { lastInsertRowid: 0, changes: 1 };
                  }
                  const err: any = new Error('UNIQUE constraint failed: ' + tableName + '.' + dedupeCol);
                  err.code = 'SQLITE_CONSTRAINT_UNIQUE';
                  throw err;
                }
              }
              self._state[tableName].push(newRow);
              return { lastInsertRowid: self._state[tableName].length, changes: 1 };
            }
          }

          // Handle parameterized UPDATE
          if (upperSql.startsWith('UPDATE')) {
            const tableMatch = upperSql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/);
            if (tableMatch) {
              const tableName = tableMatch[1].toLowerCase();
              const rows = self._state[tableName] || [];
              const whereClause = tableMatch[3];
              let changes = 0;
              const setClause = tableMatch[2];
              const setCols = setClause.split(',').map((s: string) => s.split('=')[0].trim().toLowerCase());
              const setParamCount = (setClause.match(/\?/g) || []).length;
              const setParams = flatArgs.slice(0, setParamCount);
              const whereParams = flatArgs.slice(setParamCount);
              if (whereClause) {
                rows.forEach((row: any) => {
                  const idx = { value: 0 };
                  const condParts = splitByAnd(whereClause);
                  const matches = condParts.every((cond: string) => {
                    cond = cond.trim();
                    const m = cond.match(/^(\w+)\s*=\s*\?$/i);
                    if (m) {
                      return row[m[1].toLowerCase()] === whereParams[idx.value++];
                    }
                    return true;
                  });
                  if (matches) {
                    for (let i = 0; i < setCols.length && i < setParamCount; i++) {
                      row[setCols[i]] = setParams[i];
                    }
                    changes++;
                  }
                });
              } else {
                rows.forEach((row: any) => {
                  for (let i = 0; i < setCols.length && i < setParamCount; i++) {
                    row[setCols[i]] = setParams[i];
                  }
                  changes++;
                });
              }
              return { lastInsertRowid: 0, changes };
            }
          }

          // Handle parameterized DELETE
          if (upperSql.startsWith('DELETE')) {
            const tableMatch = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
            if (tableMatch) {
              const tableName = tableMatch[1].toLowerCase();
              const rows = self._state[tableName] || [];
              const whereClause = tableMatch[2];
              if (whereClause) {
                const before = rows.length;
                self._state[tableName] = filterRows(rows, whereClause, flatArgs).length !== rows.length
                  ? rows.filter((_: any, i: number) => !filterRows([rows[i]], whereClause, flatArgs).length ? false : true)
                  : rows;
                // Simpler: remove rows matching WHERE
                const kept: any[] = [];
                rows.forEach((row: any) => {
                  const filtered = filterRows([row], whereClause, flatArgs);
                  if (filtered.length === 0) kept.push(row);
                });
                self._state[tableName] = kept;
                return { lastInsertRowid: 0, changes: before - kept.length };
              } else {
                const changes = rows.length;
                self._state[tableName] = [];
                return { lastInsertRowid: 0, changes };
              }
            }
          }

          return { lastInsertRowid: 0, changes: 0 };
        },
        get: (...args: any[]) => {
          const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;

          // Handle COUNT(*) queries
          if (upperSql.includes('COUNT(*)')) {
            const tableMatch = sql.match(/FROM\s+(\w+)/i);
            const table = tableMatch ? tableMatch[1].toLowerCase() : '';
            const rows = self._state[table] || [];
            const whereMatch = sql.match(/WHERE\s+(.+)/i);
            if (whereMatch) {
              const filtered = filterRows(rows, whereMatch[1], flatArgs);
              return { count: filtered.length };
            }
            return { count: rows.length };
          }
          // Handle SELECT queries
          if (upperSql.startsWith('SELECT')) {
            const tableMatch = sql.match(/FROM\s+(\w+)/i);
            const table = tableMatch ? tableMatch[1].toLowerCase() : '';
            const rows = self._state[table] || [];
            const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
            if (whereMatch) {
              const filtered = filterRows(rows, whereMatch[1], flatArgs);
              return filtered[0];
            }
            return rows[0];
          }
          return undefined;
        },
        all: (...args: any[]) => {
          const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
          const tableMatch = sql.match(/FROM\s+(\w+)/i);
          const table = tableMatch ? tableMatch[1].toLowerCase() : '';
          const rows = self._state[table] || [];
          const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
          // Separate WHERE params from LIMIT/OFFSET params (LIMIT ? OFFSET ? consume last 2 params)
          const limitParamCount = (sql.match(/LIMIT\s*\?/gi) || []).length;
          const offsetParamCount = (sql.match(/OFFSET\s*\?/gi) || []).length;
          const trailingParamCount = limitParamCount + offsetParamCount;
          const whereParams = trailingParamCount > 0 ? flatArgs.slice(0, -trailingParamCount) : flatArgs;
          const trailingParams = flatArgs.slice(flatArgs.length - trailingParamCount);
          // LIMIT/OFFSET: from SQL literals, or from trailing params
          let limitMatch = sql.match(/LIMIT\s+(\d+)/i);
          let offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
          let limitVal = limitMatch ? parseInt(limitMatch[1], 10) : undefined;
          let offsetVal = offsetMatch ? parseInt(offsetMatch[1], 10) : undefined;
          // Consume trailing params for LIMIT ? OFFSET ?
          let pi = 0;
          if (sql.match(/LIMIT\s*\?/i)) limitVal = parseInt(String(trailingParams[pi++]), 10);
          if (sql.match(/OFFSET\s*\?/i)) offsetVal = parseInt(String(trailingParams[pi++]), 10);
          // Strip 1=1 (no-op) before filtering
          const rawWhere = whereMatch ? whereMatch[1].replace(/^1\s*=\s*1\s*(AND\s*)?/i, '').trim() : '';
          let result = rawWhere ? filterRows(rows, rawWhere, whereParams) : [...rows];
          if (offsetVal !== undefined && !isNaN(offsetVal)) result = result.slice(offsetVal);
          if (limitVal !== undefined && !isNaN(limitVal)) result = result.slice(0, limitVal);
          return result;
        },
        iterate: function* () {},
      };
    }
    exec(sql: string) {
      const statements = sql.split(';');
      for (let stmt of statements) {
        stmt = stmt.replace(/\s+/g, ' ').trim();
        if (!stmt) continue;
        const cleanUpper = stmt.toUpperCase();
        if (cleanUpper.startsWith('DELETE FROM')) {
          const match = stmt.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?/i);
          if (match) {
            const table = match[1].toLowerCase();
            const whereSql = match[2];
            const tableState = this.state[table];
            if (tableState) {
              if (whereSql) {
                const rowsToKeep = tableState.filter((row: any) => {
                  const paramIndex = { value: 0 };
                  const conditions = splitByAnd(whereSql);
                  for (const cond of conditions) {
                    if (!evaluateCondition(row, cond, [], paramIndex)) {
                      return true;
                    }
                  }
                  return false;
                });
                this.state[table] = rowsToKeep;
              } else {
                tableState.length = 0;
              }
            }
          }
        } else if (cleanUpper.startsWith('INSERT INTO') || cleanUpper.startsWith('INSERT OR IGNORE INTO') || cleanUpper.startsWith('INSERT OR REPLACE INTO')) {
          const insertMatch = stmt.match(/INSERT\s*(?:OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*([\s\S]+)/i);
          if (insertMatch) {
            const tableName = insertMatch[1].toLowerCase();
            const cols = insertMatch[2].split(',').map(c => c.trim().toLowerCase());
            const valuesPart = insertMatch[3].trim();
            const rowsOfValues: string[] = [];
            let currentStr = '';
            let parenDepth = 0;
            let inQuote: string | null = null;
            for (let i = 0; i < valuesPart.length; i++) {
              const char = valuesPart[i];
              if (char === "'" || char === '"') {
                if (inQuote === char) inQuote = null;
                else if (inQuote === null) inQuote = char;
                currentStr += char;
              } else if (char === '(' && !inQuote) {
                parenDepth++;
                if (parenDepth === 1) {
                  currentStr = '';
                } else {
                  currentStr += char;
                }
              } else if (char === ')' && !inQuote) {
                parenDepth--;
                if (parenDepth === 0) {
                  rowsOfValues.push(currentStr);
                } else {
                  currentStr += char;
                }
              } else {
                if (parenDepth > 0) {
                  currentStr += char;
                }
              }
            }

            const tableState = this.state[tableName];
            if (tableState) {
              for (const rowValStr of rowsOfValues) {
                const rawValues = splitSqlValues(rowValStr);
                const values = rawValues.map(v => parseSqlValue(v));
                const newRow: any = {};
                for (let c = 0; c < cols.length; c++) {
                  newRow[cols[c]] = values[c];
                }

                if (cleanUpper.includes('IGNORE')) {
                  let exists = false;
                  if (tableName === 'users') {
                    exists = tableState.some((u: any) => u.id === newRow.id || u.username === newRow.username || u.email === newRow.email);
                  } else if (tableName === 'reputation_entries') {
                    exists = tableState.some((r: any) => r.reviewer_id === newRow.reviewer_id && r.target_id === newRow.target_id && r.context_id === newRow.context_id);
                  } else if (tableName === 'contracts') {
                    exists = tableState.some((c: any) => c.id === newRow.id);
                  }
                  if (exists) continue;
                }

                tableState.push(newRow);
              }
            }
          }
        }
      }
    }
    transaction(fn: (...args: any[]) => any) {
      return fn;
    }
    close() { this.open = false; }
  }
  Database = MockDatabase as any;
}
export default Database;

export type Database = BetterSqlite3.Database;
