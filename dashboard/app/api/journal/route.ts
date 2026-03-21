import { NextResponse } from 'next/server';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const DB_PATH = path.resolve(process.cwd(), 'data', 'journal.db');

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
