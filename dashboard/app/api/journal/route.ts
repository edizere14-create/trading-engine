import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const dbPath = path.resolve(process.cwd(), 'data', 'journal.db');

  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM trades ORDER BY entryTimestamp DESC LIMIT 100').all();
    db.close();
    return NextResponse.json({ trades: rows });
  } catch (err) {
    return NextResponse.json({ trades: [], error: String(err) });
  }
}
