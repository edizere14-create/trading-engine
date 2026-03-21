import { NextResponse } from 'next/server';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const DB_PATH = path.join('C:\\trading-engine', 'data', 'journal.db');

function queryAll(dbPath: string, sql: string): Record<string, unknown>[] {
  const SQL = require('sql.js');
  const initSqlJsSync = SQL.default || SQL;
  // sql.js is async but we can use the synchronous wasm if loaded
  const fileBuffer = fs.readFileSync(dbPath);
  const db = new (initSqlJsSync()).Database(fileBuffer);
  const stmt = db.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>);
  }
  stmt.free();
  db.close();
  return rows;
}

export async function GET() {
  try {
    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(fileBuffer);
    const stmt = db.prepare('SELECT * FROM trades ORDER BY entryTimestamp DESC LIMIT 100');
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    db.close();
    return NextResponse.json({ trades: rows });
  } catch (err) {
    return NextResponse.json({ trades: [], error: String(err) });
  }
}
